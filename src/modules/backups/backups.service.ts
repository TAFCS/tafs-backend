import { Injectable, Logger, InternalServerErrorException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { exec } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { existsSync, mkdirSync, createReadStream, unlinkSync } from 'fs';
import { StorageService } from '../../common/storage/storage.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { 
    S3Client, 
    ListObjectsV2Command, 
    GetObjectCommand 
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const execPromise = promisify(exec);

@Injectable()
export class BackupsService implements OnModuleInit {
    private readonly logger = new Logger(BackupsService.name);
    private readonly tempDir = join(process.cwd(), 'temp-backups');

    constructor(
        private readonly config: ConfigService,
        private readonly storage: StorageService,
        private readonly prisma: PrismaService,
    ) {}

    onModuleInit() {
        if (!existsSync(this.tempDir)) {
            mkdirSync(this.tempDir, { recursive: true });
        }
    }

    async createBackup() {
        const now = new Date();
        const timestamp = this.formatTimestamp(now);
        
        this.logger.log(`Starting dual-mode database backup (SQL + JSON) - ${timestamp}`);

        const [sql, json] = await Promise.all([
            this.createSqlBackup(timestamp),
            this.createJsonBackup(timestamp)
        ]);

        return { sql, json };
    }

    private formatTimestamp(now: Date) {
        const pktTime = new Intl.DateTimeFormat('en-PK', {
            timeZone: 'Asia/Karachi',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        }).format(now);

        const parts = pktTime.split(/[/, :]+/);
        const day = parts[0];
        const month = parts[1];
        const year = parts[2];
        const hour = parts[3];
        const minute = parts[4];
        const second = parts[5];

        return `${year}-${month}-${day}_${hour}-${minute}-${second}`;
    }

    private getBackupInfo(format: 'JSON' | 'SQL', sharedTimestamp?: string) {
        const timestamp = sharedTimestamp || this.formatTimestamp(new Date());
        const extension = format === 'JSON' ? 'json' : 'sql';
        const fileName = `TAFS_${format}_${timestamp}.${extension}.gz`;
        const filePath = join(this.tempDir, fileName);
        const rawPath = filePath.replace('.gz', '');

        return { fileName, filePath, rawPath };
    }

    private async finalizeBackup(rawPath: string, filePath: string, fileName: string) {
        const fs = require('fs');
        try {
            // 1. Compress
            await execPromise(`gzip "${rawPath}"`);
            this.logger.log(`Backup compressed: ${fileName}`);

            // 2. Upload to Storage
            const fileBuffer = fs.readFileSync(filePath);
            const storageKey = `backups/${fileName}`;
            const publicUrl = await this.storage.upload(storageKey, fileBuffer, 'application/gzip');

            this.logger.log(`Backup uploaded successfully: ${publicUrl}`);

            // 3. Cleanup
            if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

            return {
                fileName,
                storageKey,
                url: publicUrl,
            };
        } catch (error) {
            if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            throw error;
        }
    }

    async createSqlBackup(sharedTimestamp?: string) {
        const { fileName, filePath, rawPath } = this.getBackupInfo('SQL', sharedTimestamp);
        const dbUrl = this.config.get<string>('DATABASE_URL');

        if (!dbUrl) {
            throw new InternalServerErrorException('DATABASE_URL not found in environment');
        }

        // Sanitize DATABASE_URL for pg_dump (it doesn't like prisma-specific params like connection_limit)
        let sanitizedUrl = dbUrl;
        try {
            const url = new URL(dbUrl);
            url.searchParams.delete('connection_limit');
            url.searchParams.delete('pool_timeout');
            sanitizedUrl = url.toString();
        } catch (e) {
            this.logger.warn(`Failed to parse DATABASE_URL for sanitization: ${e.message}`);
        }

        this.logger.log(`Starting SQL database backup: ${fileName} (PKT)`);

        try {
            // Use pg_dump directly with the connection string
            // We use --no-owner and --no-privileges to make it more portable
            await execPromise(`pg_dump "${sanitizedUrl}" --no-owner --no-privileges -f "${rawPath}"`);
            this.logger.log(`SQL data extracted via pg_dump`);

            return await this.finalizeBackup(rawPath, filePath, fileName);
        } catch (error) {
            this.logger.error(`SQL Backup process failed: ${error.message}`);
            throw new InternalServerErrorException(`Database backup failed: ${error.message}`);
        }
    }

    async createJsonBackup(sharedTimestamp?: string) {
        const { fileName, filePath, rawPath } = this.getBackupInfo('JSON', sharedTimestamp);
        const jsonPath = rawPath;

        this.logger.log(`Starting Pure JS database backup: ${fileName} (PKT)`);

        try {
            // 1. Get all table names in the public schema
            const tables: any[] = await this.prisma.$queryRaw`
                SELECT table_name 
                FROM information_schema.tables 
                WHERE table_schema = 'public' 
                AND table_type = 'BASE TABLE'
                AND table_name NOT LIKE '_prisma_migrations';
            `;

            const backupData: Record<string, any[]> = {};

            // 2. Fetch data from each table
            for (const table of tables) {
                const tableName = table.table_name;
                this.logger.debug(`Backing up table: ${tableName}`);
                
                // Use raw query to fetch everything from the table
                const data: any[] = await this.prisma.$queryRawUnsafe(`SELECT * FROM "${tableName}"`);
                backupData[tableName] = data;
            }

            // 3. Serialize to JSON with BigInt support
            const jsonString = JSON.stringify(backupData, (key, value) => {
                if (typeof value === 'bigint') {
                    return value.toString();
                }
                return value;
            }, 2);

            // 4. Write to temp file
            const fs = require('fs');
            fs.writeFileSync(jsonPath, jsonString);
            this.logger.log(`JSON data extracted (${Object.keys(backupData).length} tables)`);

            const result = await this.finalizeBackup(rawPath, filePath, fileName);
            return {
                ...result,
                tablesCount: Object.keys(backupData).length
            };
        } catch (error) {
            this.logger.error(`JSON Backup process failed: ${error.message}`);
            throw new InternalServerErrorException(`Database backup failed: ${error.message}`);
        }
    }

    async listBackups() {
        const client = (this.storage as any).client as S3Client;
        const bucket = (this.storage as any).bucket;

        if (!client) {
            this.logger.warn('Storage client not initialized. Returning empty list.');
            return [];
        }

        try {
            const command = new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: 'backups/',
            });

            const response = await client.send(command);
            const contents = response.Contents || [];

            return contents
                .filter(item => item.Key !== 'backups/') // Filter out the directory itself
                .map(item => ({
                    key: item.Key,
                    fileName: item.Key?.replace('backups/', ''),
                    size: item.Size,
                    lastModified: item.LastModified,
                }))
                .sort((a, b) => (b.lastModified?.getTime() || 0) - (a.lastModified?.getTime() || 0));
        } catch (error) {
            this.logger.error(`Failed to list backups: ${error.message}`);
            throw new InternalServerErrorException('Could not retrieve backup list');
        }
    }

    async getFileData(key: string) {
        const sanitizedKey = key.startsWith('/') ? key.slice(1) : key;
        return this.storage.getFile(sanitizedKey);
    }

    async deleteBackup(key: string) {
        const sanitizedKey = key.startsWith('/') ? key.slice(1) : key;
        const client = (this.storage as any).client as any;
        const bucket = (this.storage as any).bucket;
        
        const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
        await client.send(new DeleteObjectCommand({
            Bucket: bucket,
            Key: sanitizedKey,
        }));
        this.logger.log(`Backup deleted from storage: ${sanitizedKey}`);
    }
}
