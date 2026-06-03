import { PrismaClient } from '@prisma/client';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

type PhotoType = 'standard' | 'blue_bg';

type UploadedRow = {
  file: string;
  gr: string;
  cc: number;
  full_name: string;
  url: string;
};

type SkippedExistingRow = {
  file: string;
  gr: string;
  cc: number;
  full_name: string;
  existing_url: string;
};

type NotFoundRow = {
  file: string;
  gr: string;
  name_from_filename: string | null;
  reason: 'NOT_FOUND' | 'AMBIGUOUS_MATCH';
};

type NoGrRow = {
  file: string;
  name_from_filename: string | null;
};

type DuplicateGrRow = {
  gr: string;
  files: string[];
};

type ErrorRow = {
  file: string;
  gr?: string;
  message: string;
};

type Report = {
  started_at: string;
  finished_at?: string;
  dir: string;
  type: PhotoType;
  dry_run: boolean;
  totals: {
    files_seen: number;
    images_considered: number;
    uploaded: number;
    skipped_existing_photo: number;
    not_found_in_db: number;
    no_gr_in_filename: number;
    duplicate_gr_in_folder: number;
    errors: number;
  };
  uploaded: UploadedRow[];
  skipped_existing_photo: SkippedExistingRow[];
  not_found_in_db: NotFoundRow[];
  no_gr_in_filename: NoGrRow[];
  duplicate_gr_in_folder: DuplicateGrRow[];
  errors: ErrorRow[];
};

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  const dir = String(args.dir || '').trim();
  const dryRun = args['dry-run'] === true || String(args['dry-run'] || '').toLowerCase() === 'true';
  const typeRaw = String(args.type || 'standard').trim();
  const type = (typeRaw === 'blue_bg' ? 'blue_bg' : 'standard') as PhotoType;
  return { dir, dryRun, type };
}

function isImageFile(filename: string) {
  const ext = path.extname(filename).toLowerCase();
  return ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp';
}

function extractGrFromFilename(filename: string): string | null {
  // Expect trailing digits in the basename (before extension), e.g. "HUSSAIN RAZA 6302.png" -> "6302"
  const base = path.basename(filename, path.extname(filename));
  const m = base.match(/(\d+)\s*$/);
  if (!m?.[1]) return null;
  return m[1];
}

function extractNameFromFilename(filename: string): string | null {
  // "HUSSAIN RAZA 6302.png" -> "HUSSAIN RAZA"
  // "MUHAMMAD SALAR AHMED PN.jpg" -> "MUHAMMAD SALAR AHMED PN" (no GR case)
  const base = path.basename(filename, path.extname(filename)).trim();
  if (!base) return null;
  const withoutTrailingNumber = base.replace(/\s*\d+\s*$/, '').trim();
  return (withoutTrailingNumber || base) || null;
}

function nowStamp() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

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
  const { dir, dryRun, type } = parseArgs(process.argv.slice(2));
  if (!dir) {
    throw new Error('Usage: ts-node scripts/bulk-upload-student-photos-by-gr.ts --dir "/path/to/folder" [--dry-run] [--type standard|blue_bg]');
  }

  const startedAt = new Date().toISOString();
  const report: Report = {
    started_at: startedAt,
    dir,
    type,
    dry_run: dryRun,
    totals: {
      files_seen: 0,
      images_considered: 0,
      uploaded: 0,
      skipped_existing_photo: 0,
      not_found_in_db: 0,
      no_gr_in_filename: 0,
      duplicate_gr_in_folder: 0,
      errors: 0,
    },
    uploaded: [],
    skipped_existing_photo: [],
    not_found_in_db: [],
    no_gr_in_filename: [],
    duplicate_gr_in_folder: [],
    errors: [],
  };

  const entries = await fs.readdir(dir, { withFileTypes: true });
  report.totals.files_seen = entries.length;

  const imageFiles = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter(isImageFile)
    .sort((a, b) => a.localeCompare(b));
  report.totals.images_considered = imageFiles.length;

  const byGr = new Map<string, string[]>();
  const parsed: Array<{ file: string; fullPath: string; gr: string | null }> = [];

  for (const file of imageFiles) {
    const gr = extractGrFromFilename(file);
    parsed.push({ file, fullPath: path.join(dir, file), gr });
    if (gr) {
      const list = byGr.get(gr) || [];
      list.push(file);
      byGr.set(gr, list);
    }
  }

  const duplicateGrs = new Set<string>();
  for (const [gr, files] of byGr.entries()) {
    if (files.length > 1) {
      duplicateGrs.add(gr);
      report.duplicate_gr_in_folder.push({ gr, files });
    }
  }
  report.totals.duplicate_gr_in_folder = report.duplicate_gr_in_folder.length;

  const prisma = new PrismaClient();

  const spaces = !dryRun ? createSpacesClientFromEnv() : null;

  const dbField = type === 'blue_bg' ? 'photo_blue_bg_url' : 'photograph_url';

  for (const item of parsed) {
    const { file, fullPath, gr } = item;
    const nameFromFilename = extractNameFromFilename(file);

    if (!gr) {
      report.no_gr_in_filename.push({ file, name_from_filename: nameFromFilename });
      continue;
    }
    if (duplicateGrs.has(gr)) {
      // Skip duplicates to avoid wrong assignment.
      continue;
    }

    try {
      // Prefer exact GR match; fall back to a contains search only if it yields exactly one result.
      let candidates = await prisma.students.findMany({
        where: { deleted_at: null, gr_number: { equals: gr, mode: 'insensitive' } },
        select: { cc: true, full_name: true, gr_number: true, photograph_url: true, photo_blue_bg_url: true },
        take: 2,
      });

      if (candidates.length === 0) {
        candidates = await prisma.students.findMany({
          where: { deleted_at: null, gr_number: { contains: gr, mode: 'insensitive' } },
          select: { cc: true, full_name: true, gr_number: true, photograph_url: true, photo_blue_bg_url: true },
          take: 2,
        });
      }

      if (candidates.length !== 1) {
        report.not_found_in_db.push({
          file,
          gr,
          name_from_filename: nameFromFilename,
          reason: candidates.length === 0 ? 'NOT_FOUND' : 'AMBIGUOUS_MATCH',
        });
        continue;
      }

      const student = candidates[0];
      const existingUrl = (dbField === 'photo_blue_bg_url' ? student.photo_blue_bg_url : student.photograph_url) || '';

      if (existingUrl) {
        report.skipped_existing_photo.push({
          file,
          gr,
          cc: student.cc,
          full_name: student.full_name,
          existing_url: existingUrl,
        });
        continue;
      }

      if (dryRun) {
        report.uploaded.push({
          file,
          gr,
          cc: student.cc,
          full_name: student.full_name,
          url: '(dry-run)',
        });
        continue;
      }

      const buffer = await fs.readFile(fullPath);
      const ext = path.extname(file).toLowerCase().replace('.', '') || 'jpg';
      const key = `media/students/${student.cc}/${type}-${Date.now()}.${ext}`;
      const mime =
        ext === 'png'
          ? 'image/png'
          : ext === 'webp'
            ? 'image/webp'
            : 'image/jpeg';

      await spaces!.client.send(
        new PutObjectCommand({
          Bucket: spaces!.bucket,
          Key: key,
          Body: buffer,
          ContentType: mime,
          ACL: 'public-read',
        }),
      );

      const url = `${spaces!.cdnEndpoint}/${key}`;

      await prisma.students.update({
        where: { cc: student.cc },
        data: { [dbField]: url } as any,
      });

      report.uploaded.push({ file, gr, cc: student.cc, full_name: student.full_name, url });
    } catch (e: any) {
      report.errors.push({ file, gr, message: e?.message || 'Unknown error' });
    }
  }

  // In dry-run, "uploaded" means "would upload".
  report.totals.uploaded = report.uploaded.length;
  report.totals.skipped_existing_photo = report.skipped_existing_photo.length;
  report.totals.not_found_in_db = report.not_found_in_db.length;
  report.totals.no_gr_in_filename = report.no_gr_in_filename.length;
  report.totals.errors = report.errors.length;
  report.finished_at = new Date().toISOString();

  const outDir = path.join(process.cwd(), 'scripts', 'out');
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `bulk-photos-report-${nowStamp()}${dryRun ? '-dryrun' : ''}.json`);
  await fs.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');

  const summary = [
    `dir=${dir}`,
    `type=${type}`,
    `dry_run=${dryRun}`,
    `files_seen=${report.totals.files_seen}`,
    `images_considered=${report.totals.images_considered}`,
    `uploaded=${report.totals.uploaded}`,
    `skipped_existing_photo=${report.totals.skipped_existing_photo}`,
    `not_found_in_db=${report.totals.not_found_in_db}`,
    `no_gr_in_filename=${report.totals.no_gr_in_filename}`,
    `duplicate_gr_in_folder=${report.totals.duplicate_gr_in_folder}`,
    `errors=${report.totals.errors}`,
    `report=${outPath}`,
  ].join(' | ');

  // eslint-disable-next-line no-console
  console.log(summary);

  await prisma.$disconnect();

  // Hard-fail only on true runtime errors (DB/S3/etc). Missing/duplicate/skip are reported but not fatal.
  if (report.errors.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});

