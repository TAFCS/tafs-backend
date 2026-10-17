import { Injectable, Logger, InternalServerErrorException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { exec } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { existsSync, mkdirSync, createReadStream, createWriteStream } from 'fs';
import { unlink, rm } from 'fs/promises';
import { finished } from 'stream/promises';
import type { WriteStream } from 'fs';
import { StorageService } from '../../common/storage/storage.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

const execPromise = promisify(exec);

/** Yield so HTTP/socket handlers (incl. iclock getrequest) can run mid-backup. */
function yieldEventLoop(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

function jsonReplacer(_key: string, value: unknown) {
    if (typeof value === 'bigint') return value.toString();
    return value;
}

function writeChunk(stream: WriteStream, chunk: string): Promise<void> {
    return new Promise((resolve, reject) => {
        try {
            if (stream.write(chunk)) {
                resolve();
            } else {
                stream.once('drain', () => resolve());
            }
        } catch (err) {
            reject(err);
        }
    });
}

@Injectable()
export class BackupsService implements OnModuleInit {
    private readonly logger = new Logger(BackupsService.name);
    private readonly tempDir = join(process.cwd(), 'temp-backups');
    /** Prevent overlapping backups from stacking pool + CPU pressure. */
    private backupInFlight = false;

    constructor(
        private readonly config: ConfigService,
        private readonly storage: StorageService,
        private readonly prisma: PrismaService,
        private readonly auditLogs: AuditLogsService,
    ) {}

    onModuleInit() {
        if (!existsSync(this.tempDir)) {
            mkdirSync(this.tempDir, { recursive: true });
        }
    }

    /**
     * @param includeJson  Off by default. JSON walks every table through Prisma
     *   and has repeatedly OOMed/GC-thrashed the Railway box (silent 499s on
     *   every route including getrequest). Scheduled backups are SQL-only;
     *   pass true only for an intentional manual dual dump.
     */
    async createBackup(changedBy?: string, includeJson = false) {
        if (this.backupInFlight) {
            throw new InternalServerErrorException(
                'A backup is already running. Wait for it to finish.',
            );
        }
        this.backupInFlight = true;
        const now = new Date();
        const timestamp = this.formatTimestamp(now);

        this.logger.log(
            `Starting database backup (${includeJson ? 'SQL + JSON' : 'SQL only'}) - ${timestamp}`,
        );

        try {
            // pg_dump runs in a child process — it does not block the Nest event loop.
            const sql = await this.createSqlBackup(timestamp);
            const json = includeJson ? await this.createJsonBackup(timestamp) : null;

            void this.auditLogs.log({
                entity_type: 'BACKUP',
                entity_id: sql.storageKey,
                action: 'CREATED',
                changed_by: changedBy ?? 'scheduled-job',
                note: json
                    ? `Backup created: ${sql.fileName} and ${json.fileName}.`
                    : `Backup created: ${sql.fileName} (SQL only).`,
            });

            return { sql, json };
        } finally {
            this.backupInFlight = false;
        }
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
        try {
            await execPromise(`gzip "${rawPath}"`);
            this.logger.log(`Backup compressed: ${fileName}`);

            const storageKey = `backups/${fileName}`;
            // Stream upload — never readFileSync a multi‑MB gzip onto the heap.
            const publicUrl = await this.storage.upload(
                storageKey,
                createReadStream(filePath),
                'application/gzip',
            );

            this.logger.log(`Backup uploaded successfully: ${publicUrl}`);

            await rm(rawPath, { force: true }).catch(() => undefined);
            await rm(filePath, { force: true }).catch(() => undefined);

            return {
                fileName,
                storageKey,
                url: publicUrl,
            };
        } catch (error) {
            await rm(rawPath, { force: true }).catch(() => undefined);
            await rm(filePath, { force: true }).catch(() => undefined);
            throw error;
        }
    }

    async createSqlBackup(sharedTimestamp?: string) {
        const { fileName, filePath, rawPath } = this.getBackupInfo('SQL', sharedTimestamp);
        const dbUrl = this.config.get<string>('DATABASE_URL');

        if (!dbUrl) {
            throw new InternalServerErrorException('DATABASE_URL not found in environment');
        }

        let sanitizedUrl = dbUrl;
        try {
            const url = new URL(dbUrl);
            url.searchParams.delete('connection_limit');
            url.searchParams.delete('pool_timeout');
            sanitizedUrl = url.toString();
        } catch (e: any) {
            this.logger.warn(`Failed to parse DATABASE_URL for sanitization: ${e.message}`);
        }

        this.logger.log(`Starting SQL database backup: ${fileName} (PKT)`);

        try {
            await execPromise(`pg_dump "${sanitizedUrl}" --no-owner --no-privileges -f "${rawPath}"`);
            this.logger.log(`SQL data extracted via pg_dump`);

            return await this.finalizeBackup(rawPath, filePath, fileName);
        } catch (error: any) {
            this.logger.error(`SQL Backup process failed: ${error.message}`);
            throw new InternalServerErrorException(`Database backup failed: ${error.message}`);
        }
    }

    async createJsonBackup(sharedTimestamp?: string) {
        const { fileName, filePath, rawPath } = this.getBackupInfo('JSON', sharedTimestamp);
        const jsonPath = rawPath;

        this.logger.log(`Starting Pure JS database backup: ${fileName} (PKT)`);

        try {
            const tables: Array<{ table_name: string }> = await this.prisma.$queryRaw`
                SELECT table_name 
                FROM information_schema.tables 
                WHERE table_schema = 'public' 
                AND table_type = 'BASE TABLE'
                AND table_name NOT LIKE '_prisma_migrations'
            `;

            const stream = createWriteStream(jsonPath, { encoding: 'utf8' });
            await writeChunk(stream, '{');

            const PAGE = 500;
            let firstTable = true;
            for (const table of tables) {
                const tableName = table.table_name;
                this.logger.debug(`Backing up table: ${tableName}`);
                if (!firstTable) await writeChunk(stream, ',');
                firstTable = false;
                await writeChunk(stream, `\n${JSON.stringify(tableName)}:`);
                await writeChunk(stream, '[');

                try {
                    // Page through the table. A single SELECT * on zk_attendance_scans /
                    // audit_logs loaded hundreds of MB into V8 and GC-froze the process
                    // for minutes (getrequest 499s with no error log).
                    let offset = 0;
                    let firstRow = true;
                    for (;;) {
                        const data: unknown[] = await this.prisma.$queryRawUnsafe(
                            `SELECT * FROM "public"."${tableName}" LIMIT ${PAGE} OFFSET ${offset}`,
                        );
                        if (data.length === 0) break;
                        for (let i = 0; i < data.length; i++) {
                            if (!firstRow) await writeChunk(stream, ',');
                            firstRow = false;
                            await writeChunk(stream, JSON.stringify(data[i], jsonReplacer));
                            if (i % 50 === 0) await yieldEventLoop();
                        }
                        offset += data.length;
                        await yieldEventLoop();
                        if (data.length < PAGE) break;
                    }
                } catch (tableError: any) {
                    this.logger.warn(
                        `Failed to back up table ${tableName}, writing empty array. Error: ${tableError.message}`,
                    );
                }

                await writeChunk(stream, ']');
                await yieldEventLoop();
            }

            await writeChunk(stream, '\n}\n');
            stream.end();
            await finished(stream);

            this.logger.log(`JSON data extracted (${tables.length} tables)`);

            const result = await this.finalizeBackup(rawPath, filePath, fileName);
            return {
                ...result,
                tablesCount: tables.length,
            };
        } catch (error: any) {
            this.logger.error(`JSON Backup process failed: ${error.message}`);
            await unlink(jsonPath).catch(() => undefined);
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
                .filter((item) => item.Key !== 'backups/')
                .map((item) => ({
                    key: item.Key,
                    fileName: item.Key?.replace('backups/', ''),
                    size: item.Size,
                    lastModified: item.LastModified,
                }))
                .sort((a, b) => (b.lastModified?.getTime() || 0) - (a.lastModified?.getTime() || 0));
        } catch (error: any) {
            this.logger.error(`Failed to list backups: ${error.message}`);
            throw new InternalServerErrorException('Could not retrieve backup list');
        }
    }

    async getFileData(key: string) {
        const sanitizedKey = key.startsWith('/') ? key.slice(1) : key;
        return this.storage.getFile(sanitizedKey);
    }

    async deleteBackup(key: string, changedBy: string) {
        const sanitizedKey = key.startsWith('/') ? key.slice(1) : key;
        const client = (this.storage as any).client as any;
        const bucket = (this.storage as any).bucket;

        const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
        await client.send(
            new DeleteObjectCommand({
                Bucket: bucket,
                Key: sanitizedKey,
            }),
        );
        this.logger.log(`Backup deleted from storage: ${sanitizedKey}`);

        void this.auditLogs.log({
            entity_type: 'BACKUP',
            entity_id: sanitizedKey,
            action: 'DELETED',
            changed_by: changedBy,
            note: `Deleted backup ${sanitizedKey.split('/').pop() ?? sanitizedKey}.`,
        });
    }
}
