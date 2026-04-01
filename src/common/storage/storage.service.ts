import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
    S3Client,
    PutObjectCommand,
    DeleteObjectCommand,
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
                this.config.get<string>('DO_SPACES_CDN_ENDPOINT') ??
                `${this.uploadEndpoint}/${this.bucket}`;

            this.client = new S3Client({
                region: region!,
                endpoint: this.uploadEndpoint,
                credentials: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! },
                // If endpoint already includes bucket host, force path-style to avoid duplicate bucket hostnames.
                forcePathStyle: isBucketQualifiedEndpoint,
            });

            this.logger.log(
                `Storage initialized with endpoint "${this.uploadEndpoint}" (bucketQualifiedInput=${isBucketQualifiedEndpoint})`,
            );
        }
    }

    /**
     * Upload a buffer to DigitalOcean Spaces and return the public CDN URL.
     *
     * @param key    Object key / path inside the bucket, e.g. "vouchers/2026/voucher-42.pdf"
     * @param body   File buffer
     * @param mime   MIME type, defaults to "application/pdf"
     */
    async upload(key: string, body: Buffer, mime = 'application/pdf'): Promise<string> {
        if (!this.client) {
            this.logger.log(`Mocking upload for ${key} (storage not configured)`);
            return `${this.cdnEndpoint}/${key}`;
        }
        try {
            await this.client.send(
                new PutObjectCommand({
                    Bucket: this.bucket,
                    Key: key,
                    Body: body,
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
}
