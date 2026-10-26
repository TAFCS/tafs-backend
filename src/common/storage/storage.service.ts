import { Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
    S3Client,
    PutObjectCommand,
    DeleteObjectCommand,
    PutBucketCorsCommand,
} from '@aws-sdk/client-s3';

@Injectable()
export class StorageService {
    private readonly logger = new Logger(StorageService.name);
    private readonly client: S3Client;
    private readonly bucket: string;
    private readonly cdnEndpoint: string;
    private readonly uploadEndpoint: string;

    constructor(private readonly config: ConfigService) {
        const region = this.config.get<string>('DO_SPACES_REGION');
        const endpoint = this.config.get<string>('DO_SPACES_ENDPOINT');
        const accessKeyId = this.config.get<string>('DO_SPACES_KEY');
        const secretAccessKey = this.config.get<string>('DO_SPACES_SECRET');
        this.bucket = this.config.get<string>('DO_SPACES_BUCKET') || 'missing-bucket';
        const regionEndpoint = region ? `https://${region}.digitaloceanspaces.com` : '';
        const normalizedEndpoint = (endpoint || '').trim().replace(/\/+$/, '');

        const isConfigMissing = !region || !accessKeyId || !secretAccessKey || accessKeyId === 'your_access_key';

        if (isConfigMissing) {
            this.logger.warn('Storage configuration is missing or using placeholders. Uploads will be mocked.');
            this.client = null as any;
            this.cdnEndpoint = 'http://mock-storage';
            this.uploadEndpoint = '';
        } else {
            const rawHost = (() => {
                try {
                    return new URL(normalizedEndpoint || regionEndpoint).host.toLowerCase();
                } catch {
                    return '';
                }
            })();
            const bucketPrefix = `${this.bucket.toLowerCase()}.`;
            const isBucketQualifiedEndpoint = rawHost.startsWith(bucketPrefix);
            this.uploadEndpoint = isBucketQualifiedEndpoint ? regionEndpoint : (normalizedEndpoint || regionEndpoint);
            this.cdnEndpoint =
                (this.config.get<string>('DO_SPACES_CDN_ENDPOINT') || `${this.uploadEndpoint}/${this.bucket}`)
                .trim()
                .replace(/\/+$/, '');

            this.client = new S3Client({
                region: region!,
                endpoint: this.uploadEndpoint,
                credentials: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! },
                forcePathStyle: isBucketQualifiedEndpoint,
            });

            this.logger.log(
                `Storage initialized with endpoint "${this.uploadEndpoint}" (bucketQualifiedInput=${isBucketQualifiedEndpoint})`,
            );

            // Apply CORS policy to the bucket so browsers can load assets directly.
            // This is idempotent — safe to run on every startup.
            this.ensureBucketCors().catch((err) =>
                this.logger.warn(`Could not set bucket CORS: ${err?.message}`),
            );
        }
    }

    /**
     * Sets a permissive CORS policy on the Spaces bucket so that browsers
     * (Flutter Web, React webapp) can load images and audio files directly
     * from the CDN without CORS errors.
     *
     * Only allows GET and HEAD on all objects (*) from any origin.
     * PUT/POST still require authentication via the backend.
     */
    private async ensureBucketCors(): Promise<void> {
        await this.client.send(
            new PutBucketCorsCommand({
                Bucket: this.bucket,
                CORSConfiguration: {
                    CORSRules: [
                        {
                            AllowedOrigins: ['*'],
                            AllowedMethods: ['GET', 'HEAD'],
                            AllowedHeaders: ['*'],
                            ExposeHeaders: ['Content-Length', 'Content-Type', 'ETag'],
                            MaxAgeSeconds: 3600,
                        },
                    ],
                },
            }),
        );
        this.logger.log(`✅ Bucket CORS policy applied to "${this.bucket}"`);
    }


    /** Returns the public CDN URL for a given key without uploading anything. */
    getPublicUrl(key: string): string {
        return `${this.cdnEndpoint}/${key}`;
    }

    /** Extracts the storage key from a full CDN URL. */
    extractKeyFromUrl(url: string): string {
        if (!url) return '';
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            return url.replace(/^\/+/, '');
        }
        if (this.cdnEndpoint && url.startsWith(`${this.cdnEndpoint}/`)) {
            return url.slice(`${this.cdnEndpoint}/`.length).split('?')[0];
        }
        if (this.uploadEndpoint && url.startsWith(`${this.uploadEndpoint}/`)) {
            let key = url.slice(`${this.uploadEndpoint}/`.length).split('?')[0];
            if (this.bucket && key.startsWith(`${this.bucket}/`)) {
                key = key.slice(`${this.bucket}/`.length);
            }
            return key;
        }
        try {
            const parsed = new URL(url);
            let p = parsed.pathname.replace(/^\/+/, '');
            if (this.bucket && p.startsWith(`${this.bucket}/`)) {
                p = p.slice(`${this.bucket}/`.length);
            }
            return p;
        } catch {
            return url.replace(`${this.cdnEndpoint}/`, '');
        }
    }

    /**
     * Upload a buffer or readable stream to DigitalOcean Spaces and return the
     * public CDN URL. Streams are preferred for large artifacts (backups) so the
     * Nest process never holds the whole object in memory.
     *
     * @param key    Object key / path inside the bucket, e.g. "vouchers/2026/voucher-42.pdf"
     * @param body   File buffer or readable stream
     * @param mime   MIME type, defaults to "application/pdf"
     */
    async upload(
        key: string,
        body: Buffer | NodeJS.ReadableStream,
        mime = 'application/pdf',
    ): Promise<string> {
        if (!this.client) {
            this.logger.log(`Mocking upload for ${key} (storage not configured)`);
            return `${this.cdnEndpoint}/${key}`;
        }
        try {
            await this.client.send(
                new PutObjectCommand({
                    Bucket: this.bucket,
                    Key: key,
                    Body: body as any,
                    ContentType: mime,
                    ACL: 'public-read',
                }),
            );

            return `${this.cdnEndpoint}/${key}`;
        } catch (err: any) {
            this.logger.error(`Failed to upload ${key}`, err?.message, err?.stack);
            throw new InternalServerErrorException('File upload to storage failed');
        }
    }

    /**
     * Delete an object from DigitalOcean Spaces by its full CDN/public URL.
     * Silently ignores errors (best-effort cleanup).
     */
    async deleteByUrl(url: string): Promise<void> {
        if (!this.client) return;
        try {
            const key = url.replace(`${this.cdnEndpoint}/`, '');
            await this.client.send(
                new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
            );
        } catch (err: any) {
            this.logger.warn(`Failed to delete object at ${url}`, err?.message);
        }
    }

    /**
     * Fetch an object from DigitalOcean Spaces as a buffer.
     */
    async getFile(key: string): Promise<{ buffer: Buffer; mime: string }> {
        if (!this.client) {
            throw new InternalServerErrorException('Storage not configured');
        }
        try {
            const { GetObjectCommand } = await import('@aws-sdk/client-s3');
            const response = await this.client.send(
                new GetObjectCommand({
                    Bucket: this.bucket,
                    Key: key,
                }),
            );

            const streamToBuffer = (stream: any): Promise<Buffer> =>
                new Promise((resolve, reject) => {
                    const chunks: any[] = [];
                    stream.on('data', (chunk: any) => chunks.push(chunk));
                    stream.on('error', reject);
                    stream.on('end', () => resolve(Buffer.concat(chunks)));
                });

            const buffer = await streamToBuffer(response.Body);
            return { buffer, mime: response.ContentType || 'application/octet-stream' };
        } catch (err: any) {
            this.logger.error(`Failed to fetch ${key}: ${err?.message}`, err?.stack);
            throw new NotFoundException('File not found in storage');
        }
    }
    /**
     * Generate a signed URL for temporary access to a private object.
     */
    async getSignedUrl(key: string, expiresIn = 900): Promise<string> {
        if (!this.client) {
            throw new InternalServerErrorException('Storage not configured');
        }
        try {
            const { GetObjectCommand } = await import('@aws-sdk/client-s3');
            const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
            
            const command = new GetObjectCommand({
                Bucket: this.bucket,
                Key: key,
                // Explicitly disable checksum mode which can cause "SignatureDoesNotMatch" on DO Spaces
                ChecksumMode: undefined,
            });

            return await getSignedUrl(this.client, command, { 
                expiresIn,
                // Ensure we don't include extra headers that DO might reject
                signableHeaders: new Set(['host'])
            });
        } catch (err: any) {
            this.logger.error(`Failed to generate signed URL for ${key}`, err?.message);
            throw new InternalServerErrorException('Failed to generate download link');
        }
    }

    /**
     * Lists all photo objects stored in Spaces for a student under `media/students/${cc}/`.
     * Returns an array sorted chronologically by upload date.
     */
    async listStudentPhotos(cc: number): Promise<Array<{ url: string; date: string; timestamp: number }>> {
        if (!this.client) return [];
        try {
            const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
            const res = await this.client.send(
                new ListObjectsV2Command({
                    Bucket: this.bucket,
                    Prefix: `media/students/${cc}/`,
                }),
            );
            const items = (res.Contents || [])
                .filter((o) => o.Key && /\.(jpe?g|png|webp|gif)$/i.test(o.Key))
                .map((o) => {
                    const match = o.Key!.match(/-(?:[a-z_]+-)?(\d{10,13})\./i) || o.Key!.match(/(\d{10,13})/);
                    let date = o.LastModified || new Date();
                    if (match) {
                        const ms = parseInt(match[1], 10);
                        if (ms > 1000000000000) date = new Date(ms);
                        else if (ms > 1000000000) date = new Date(ms * 1000);
                    }
                    return {
                        url: this.getPublicUrl(o.Key!),
                        date: date.toISOString().slice(0, 10),
                        timestamp: date.getTime(),
                    };
                })
                .sort((a, b) => a.timestamp - b.timestamp);

            return items;
        } catch (err: any) {
            this.logger.warn(`Failed to list student photos in Spaces for CC ${cc}: ${err.message}`);
            return [];
        }
    }
}

