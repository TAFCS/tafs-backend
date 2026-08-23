import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

function requiredEnv(name: string): string {
  const v = (process.env[name] || '').trim();
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

function createSpacesClientFromEnv() {
  const region = requiredEnv('DO_SPACES_REGION');
  const endpointInput = (process.env.DO_SPACES_ENDPOINT || '').trim().replace(/\/+$/, '');
  const accessKeyId = requiredEnv('DO_SPACES_KEY');
  const secretAccessKey = requiredEnv('DO_SPACES_SECRET');
  const bucket = requiredEnv('DO_SPACES_BUCKET');

  const regionEndpoint = `https://${region}.digitaloceanspaces.com`;
  const normalizedEndpoint = endpointInput || regionEndpoint;

  const rawHost = (() => {
    try {
      return new URL(normalizedEndpoint).host.toLowerCase();
    } catch {
      return '';
    }
  })();
  const bucketPrefix = `${bucket.toLowerCase()}.`;
  const isBucketQualifiedEndpoint = rawHost.startsWith(bucketPrefix);
  const uploadEndpoint = isBucketQualifiedEndpoint ? regionEndpoint : normalizedEndpoint;

  const cdnEndpoint = (process.env.DO_SPACES_CDN_ENDPOINT || `${uploadEndpoint}/${bucket}`)
    .trim()
    .replace(/\/+$/, '');

  const client = new S3Client({
    region,
    endpoint: uploadEndpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: isBucketQualifiedEndpoint,
  });

  return { client, bucket, cdnEndpoint };
}

async function main() {
  const fileArg = process.argv.find((a) => a.startsWith('--file='))?.slice('--file='.length);
  const keyArg =
    process.argv.find((a) => a.startsWith('--key='))?.slice('--key='.length) ||
    'demos/student-directory/student-directory-demo.mp4';

  if (!fileArg) {
    throw new Error('Usage: ts-node scripts/upload-demo-video.ts --file=/path/to/video.mp4 [--key=demos/student-directory/student-directory-demo.mp4]');
  }

  const resolvedFile = path.resolve(fileArg);
  const buffer = await fs.readFile(resolvedFile);
  const { client, bucket, cdnEndpoint } = createSpacesClientFromEnv();

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: keyArg,
      Body: buffer,
      ContentType: 'video/mp4',
      ACL: 'public-read',
    }),
  );

  const url = `${cdnEndpoint}/${keyArg}`;
  console.log(`Uploaded ${resolvedFile}`);
  console.log(`CDN URL: ${url}`);
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
