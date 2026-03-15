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

    constructor(private readonly config: ConfigService) {
        const region = this.config.getOrThrow<string>('DO_SPACES_REGION');
        const endpoint = this.config.getOrThrow<string>('DO_SPACES_ENDPOINT'); // e.g. https://nyc3.digitaloceanspaces.com
        const accessKeyId = this.config.getOrThrow<string>('DO_SPACES_KEY');
        const secretAccessKey = this.config.getOrThrow<string>('DO_SPACES_SECRET');

        this.bucket = this.config.getOrThrow<string>('DO_SPACES_BUCKET');

        // CDN endpoint, e.g. https://<bucket>.nyc3.cdn.digitaloceanspaces.com
        // Falls back to the regular Spaces endpoint if CDN is not configured.
        this.cdnEndpoint =
            this.config.get<string>('DO_SPACES_CDN_ENDPOINT') ??
            `${endpoint}/${this.bucket}`;

        this.client = new S3Client({
            region,
            endpoint,
            credentials: { accessKeyId, secretAccessKey },
            forcePathStyle: false, // DigitalOcean Spaces requires virtual-hosted style
        });
    }

    /**
     * Upload a buffer to DigitalOcean Spaces and return the public CDN URL.
     *
     * @param key    Object key / path inside the bucket, e.g. "vouchers/2026/voucher-42.pdf"
     * @param body   File buffer
     * @param mime   MIME type, defaults to "application/pdf"
     */
    async upload(key: string, body: Buffer, mime = 'application/pdf'): Promise<string> {
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
