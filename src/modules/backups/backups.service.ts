import { Injectable, Logger, InternalServerErrorException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'child_process';
import { createGzip } from 'zlib';
import { join } from 'path';
import { existsSync, mkdirSync, createReadStream, createWriteStream } from 'fs';
import { unlink, rm } from 'fs/promises';
import { finished, pipeline } from 'stream/promises';
import type { WriteStream } from 'fs';
import { StorageService } from '../../common/storage/storage.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { FcmService } from '../../common/fcm/fcm.service';
import { StaffRole } from '@prisma/client';
import { S3Client, ListObjectsV2Command, type ListObjectsV2CommandOutput } from '@aws-sdk/client-s3';

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
        private readonly fcmService: FcmService,
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
            hourCycle: 'h23',
        }).format(now);

        const parts = pktTime.split(/[/, :]+/);
        const day = parts[0];
        const month = parts[1];
        const year = parts[2];
        let hour = parts[3];
        // Enforce 00 instead of 24 for midnight across all Intl locales
        if (hour === '24') hour = '00';
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
            const inStream = createReadStream(rawPath);
            const gzip = createGzip({ level: 6 });
            const outStream = createWriteStream(filePath);
            await pipeline(inStream, gzip, outStream);
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

    /**
     * Resolves the direct database connection string for pg_dump.
     * DigitalOcean / Managed Postgres PgBouncer (transaction pooler on port 25061 / pooler)
     * rejects session features (SET synchronize_seqscans) and pg_dump rejects ?pgbouncer=true.
     * We prefer DIRECT_URL (direct port 25060 / defaultdb) and strip all non-standard URI parameters.
     */
    private getDumpDatabaseUrl(): string {
        const directUrl = this.config.get<string>('DIRECT_URL');
        const dbUrl = directUrl || this.config.get<string>('DATABASE_URL');

        if (!dbUrl) {
            throw new InternalServerErrorException('Neither DIRECT_URL nor DATABASE_URL found in environment');
        }

        try {
            const url = new URL(dbUrl);
            // pg_dump rejects Prisma / PgBouncer specific query parameters
            url.searchParams.delete('connection_limit');
            url.searchParams.delete('pool_timeout');
            url.searchParams.delete('pgbouncer');

            // If pointing to DigitalOcean PgBouncer transaction pooler (port 25061 or /pooler db),
            // rewrite to direct postgres port 25060 and defaultdb to prevent SET synchronize_seqscans error
            if (url.port === '25061' || url.pathname === '/pooler') {
                this.logger.warn(
                    `[Backups] Rewriting PgBouncer connection (port: ${url.port}, path: ${url.pathname}) to direct database port (25060, defaultdb) for pg_dump`,
                );
                if (url.port === '25061') url.port = '25060';
                if (url.pathname === '/pooler') url.pathname = '/defaultdb';
            }

            return url.toString();
        } catch (e: any) {
            this.logger.warn(`Failed to parse database URL for pg_dump: ${e.message}`);
            return dbUrl;
        }
    }

    async createSqlBackup(sharedTimestamp?: string) {
        const { fileName, filePath } = this.getBackupInfo('SQL', sharedTimestamp);
        const sanitizedUrl = this.getDumpDatabaseUrl();

        this.logger.log(`Starting SQL database backup: ${fileName} (PKT)`);

        try {
            // Stream pg_dump stdout directly into createGzip() and write only the compressed file to disk.
            // Avoids shell maxBuffer limit and avoids writing 300+ MB uncompressed SQL to disk.
            const dumpProcess = spawn('pg_dump', [
                sanitizedUrl,
                '--no-owner',
                '--no-privileges',
            ], {
                env: process.env,
                stdio: ['ignore', 'pipe', 'pipe'],
            });

            let stderrOutput = '';
            dumpProcess.stderr.on('data', (chunk) => {
                stderrOutput += chunk.toString();
            });

            const exitPromise = new Promise<void>((resolve, reject) => {
                dumpProcess.on('close', (code) => {
                    if (code === 0) {
                        resolve();
                    } else {
                        reject(new Error(`pg_dump exited with code ${code}: ${stderrOutput.trim()}`));
                    }
                });
                dumpProcess.on('error', (err) => {
                    reject(new Error(`Failed to start pg_dump process: ${err.message}`));
                });
            });

            const gzipStream = createGzip({ level: 6 });
            const fileWriteStream = createWriteStream(filePath);

            await Promise.all([
                pipeline(dumpProcess.stdout, gzipStream, fileWriteStream),
                exitPromise,
            ]);

            this.logger.log(`SQL data extracted and compressed: ${fileName}`);

            const storageKey = `backups/${fileName}`;
            const publicUrl = await this.storage.upload(
                storageKey,
                createReadStream(filePath),
                'application/gzip',
            );

            this.logger.log(`SQL backup uploaded successfully: ${publicUrl}`);
            await unlink(filePath).catch(() => undefined);

            return {
                fileName,
                storageKey,
                url: publicUrl,
            };
        } catch (error: any) {
            await unlink(filePath).catch(() => undefined);
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

    /**
     * Lists backups from Spaces, paginating through all ContinuationTokens
     * so that the full history is retrieved beyond the 1,000 object limit.
     */
    async listBackups() {
        const client = (this.storage as any).client as S3Client;
        const bucket = (this.storage as any).bucket;

        if (!client) {
            this.logger.warn('Storage client not initialized. Returning empty list.');
            return [];
        }

        try {
            const allContents: any[] = [];
            let continuationToken: string | undefined = undefined;

            do {
                const command = new ListObjectsV2Command({
                    Bucket: bucket,
                    Prefix: 'backups/',
                    ContinuationToken: continuationToken,
                });

                const response: ListObjectsV2CommandOutput = await client.send(command);
                if (response.Contents) {
                    allContents.push(...response.Contents);
                }
                continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
            } while (continuationToken);

            return allContents
                .filter((item) => item.Key && item.Key !== 'backups/')
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

    /**
     * Alert super admins via Audit Log and FCM push when automated backup fails.
     */
    async notifyBackupFailure(actor: string, errorMessage: string) {
        try {
            await this.auditLogs.log({
                entity_type: 'BACKUP',
                entity_id: 'automated-job',
                action: 'FAILED',
                changed_by: actor,
                note: `Database backup failed: ${errorMessage.slice(0, 500)}`,
            });
        } catch (logErr: any) {
            this.logger.warn(`Failed to write backup failure audit log: ${logErr.message}`);
        }

        try {
            const superAdmins = await this.prisma.users.findMany({
                where: {
                    role: StaffRole.SUPER_ADMIN,
                    is_active: true,
                    deleted_at: null,
                },
                select: { id: true },
            });

            if (superAdmins.length > 0) {
                await this.fcmService.sendToUsers(
                    superAdmins.map((u) => u.id),
                    'Database Backup Failed',
                    `Automated database backup failed: ${errorMessage.slice(0, 150)}`,
                    { type: 'BACKUP_FAILED' },
                );
            }
        } catch (fcmErr: any) {
            this.logger.warn(`Failed to push backup failure notification: ${fcmErr.message}`);
        }
    }
}
