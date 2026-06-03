import { PrismaClient } from '@prisma/client';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

type PhotoType = 'standard' | 'blue_bg';

type UploadedRow = { file: string; rel_path: string; gr: string; cc: number; full_name: string; url: string };
type SkippedExistingRow = {
  file: string;
  rel_path: string;
  gr: string;
  cc: number;
  full_name: string;
  existing_url: string;
};
type NotFoundRow = {
  file: string;
  rel_path: string;
  gr: string;
  name_from_filename: string | null;
  reason: 'NOT_FOUND' | 'AMBIGUOUS_MATCH';
};
type NoGrRow = { file: string; rel_path: string; name_from_filename: string | null };
type DuplicateGrRow = { gr: string; files: Array<{ file: string; rel_path: string }> };
type ErrorRow = { file: string; rel_path: string; gr?: string; message: string };
type GrCorrectedRow = {
  file: string;
  rel_path: string;
  derived_gr: string;
  cc: number;
  full_name: string;
  old_gr_number: string | null;
  new_gr_number: string;
};

type Report = {
  started_at: string;
  finished_at?: string;
  root: string;
  campus_codes: string[];
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
    gr_corrected: number;
    errors: number;
  };
  uploaded: UploadedRow[];
  skipped_existing_photo: SkippedExistingRow[];
  not_found_in_db: NotFoundRow[];
  no_gr_in_filename: NoGrRow[];
  duplicate_gr_in_folder: DuplicateGrRow[];
  gr_corrected: GrCorrectedRow[];
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

  const root = String(args.root || args.dir || '').trim();
  const dryRun = args['dry-run'] === true || String(args['dry-run'] || '').toLowerCase() === 'true';
  const typeRaw = String(args.type || 'standard').trim();
  const type = (typeRaw === 'blue_bg' ? 'blue_bg' : 'standard') as PhotoType;

  // Default to "KF" but allow comma-separated list: "KF,GKF"
  const campusCodesRaw = String(args['campus-codes'] || args['campus-code'] || 'KF').trim();
  const campus_codes = campusCodesRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return { root, dryRun, type, campus_codes };
}

function isImageFile(filename: string) {
  const ext = path.extname(filename).toLowerCase();
  return ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp';
}

function extractNameFromFilename(filename: string): string | null {
  const base = path.basename(filename, path.extname(filename)).trim();
  if (!base) return null;
  // Remove trailing GR-like token (KF-A48 or 0014)
  const cleaned = base
    .replace(/\bKF[-_ ]?[A-Z]{1,3}\d{1,4}\b/gi, '')
    .replace(/\s*\d{1,5}\s*$/, '')
    .trim();
  return (cleaned || base) || null;
}

function normalizeKfGr(raw: string): string {
  // Examples:
  // - "KF A48" -> "KF-A48"
  // - "kf-a48" -> "KF-A48"
  // - "KF_A48" -> "KF-A48"
  const s = raw.trim().replace(/[_\s]+/g, '-').replace(/-+/g, '-');
  const m = s.match(/^KF-?([A-Z]{1,3})(\d{1,4})$/i);
  if (!m) return raw.trim();
  return `KF-${m[1].toUpperCase()}${m[2]}`;
}

function extractGrFromFilename(filename: string): string | null {
  // Kaneez Fatima GR format: KF-A48 (may appear anywhere in the filename)
  const base = path.basename(filename, path.extname(filename));
  const kf = base.match(/\bKF[-_ ]?[A-Z]{1,3}\d{1,4}\b/i);
  if (kf?.[0]) return normalizeKfGr(kf[0]);

  // Fallback: numeric labels like 00048, 0048, 37, etc.
  // Kaneez Fatima mapping rule: 0048 -> KF-A48 (strip leading zeros, prefix "KF-A").
  const trailing = base.match(/(\d{1,5})\s*$/);
  if (trailing?.[1]) {
    const n = Number(trailing[1]);
    if (!Number.isFinite(n) || n <= 0) return null;
    return `KF-A${n}`;
  }

  return null;
}

function kfGrVariants(gr: string): string[] {
  // Accept common DB formats:
  // - KF-A48
  // - KF-A048 / KF-A0048 / KF-A00048 (leading zero padding)
  const normalized = normalizeKfGr(gr);
  const m = normalized.match(/^KF-([A-Z]{1,3})(\d{1,8})$/i);
  if (!m) return [normalized];
  const prefix = `KF-${m[1].toUpperCase()}`;
  const digits = String(Number(m[2])); // strip leading zeros
  const pads = [
    digits,
    digits.padStart(2, '0'),
    digits.padStart(3, '0'),
    digits.padStart(4, '0'),
    digits.padStart(5, '0'),
  ];
  return Array.from(new Set(pads.map((d) => `${prefix}${d}`)));
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

async function listFilesRecursive(root: string) {
  // Recursively list files under root, ignoring hidden/system entries.
  const out: Array<{ abs: string; rel: string; file: string }> = [];

  const walk = async (dirAbs: string, dirRel: string) => {
    const entries = await fs.readdir(dirAbs, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dirAbs, e.name);
      const rel = dirRel ? path.join(dirRel, e.name) : e.name;
      if (e.isDirectory()) {
        await walk(abs, rel);
      } else if (e.isFile()) {
        out.push({ abs, rel, file: e.name });
      }
    }
  };

  await walk(root, '');
  return out;
}

async function main() {
  const { root, dryRun, type, campus_codes } = parseArgs(process.argv.slice(2));
  if (!root) {
    throw new Error(
      'Usage: ts-node scripts/bulk-upload-kaneez-fatima-photos.ts --root "/path/to/GKF" [--campus-codes KF] [--dry-run] [--type standard|blue_bg]',
    );
  }
  if (campus_codes.length === 0) {
    throw new Error('Provide at least one campus code via --campus-codes (e.g. KF)');
  }

  const report: Report = {
    started_at: new Date().toISOString(),
    root,
    campus_codes,
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
      gr_corrected: 0,
      errors: 0,
    },
    uploaded: [],
    skipped_existing_photo: [],
    not_found_in_db: [],
    no_gr_in_filename: [],
    duplicate_gr_in_folder: [],
    gr_corrected: [],
    errors: [],
  };

  const allFiles = await listFilesRecursive(root);
  report.totals.files_seen = allFiles.length;

  const images = allFiles.filter((f) => isImageFile(f.file));
  report.totals.images_considered = images.length;

  const parsed = images.map((f) => ({
    ...f,
    gr: extractGrFromFilename(f.file),
    name_from_filename: extractNameFromFilename(f.file),
  }));

  const byGr = new Map<string, Array<{ file: string; rel_path: string; abs: string }>>();
  for (const p of parsed) {
    if (!p.gr) continue;
    const list = byGr.get(p.gr) || [];
    list.push({ file: p.file, rel_path: p.rel, abs: p.abs });
    byGr.set(p.gr, list);
  }

  const duplicateGrs = new Set<string>();
  for (const [gr, files] of byGr.entries()) {
    if (files.length > 1) {
      duplicateGrs.add(gr);
      report.duplicate_gr_in_folder.push({ gr, files: files.map((x) => ({ file: x.file, rel_path: x.rel_path })) });
    }
  }
  report.totals.duplicate_gr_in_folder = report.duplicate_gr_in_folder.length;

  const prisma = new PrismaClient();

  const campusRows = await prisma.campuses.findMany({
    where: { campus_code: { in: campus_codes } },
    select: { id: true, campus_code: true, campus_name: true },
  });
  if (campusRows.length === 0) {
    throw new Error(
      `No campuses found for campus_codes=[${campus_codes.join(
        ', ',
      )}]. Use the correct campus_code from the campuses table (e.g. you may need "GKF" instead of "KF").`,
    );
  }
  const campusIds = campusRows.map((c) => c.id);

  const spaces = !dryRun ? createSpacesClientFromEnv() : null;
  const dbField = type === 'blue_bg' ? 'photo_blue_bg_url' : 'photograph_url';

  for (const p of parsed) {
    const { file, abs, rel, gr, name_from_filename } = p;
    if (!gr) {
      report.no_gr_in_filename.push({ file, rel_path: rel, name_from_filename });
      continue;
    }
    if (duplicateGrs.has(gr)) {
      continue;
    }

    try {
      const baseWhere = { deleted_at: null, campus_id: { in: campusIds } } as any;

      const variants = kfGrVariants(gr);
      let candidates = await prisma.students.findMany({
        where: { ...baseWhere, OR: variants.map((v) => ({ gr_number: { equals: v, mode: 'insensitive' } })) },
        select: { cc: true, full_name: true, gr_number: true, photograph_url: true, photo_blue_bg_url: true },
        take: 2,
      });

      if (candidates.length === 0) {
        candidates = await prisma.students.findMany({
          where: { ...baseWhere, OR: variants.map((v) => ({ gr_number: { contains: v, mode: 'insensitive' } })) },
          select: { cc: true, full_name: true, gr_number: true, photograph_url: true, photo_blue_bg_url: true },
          take: 2,
        });
      }

      // If no match by GR, try to match by name (within the campus), then correct gr_number to derived GR.
      if (candidates.length === 0 && name_from_filename) {
        const nameCandidates = await prisma.students.findMany({
          where: { ...baseWhere, full_name: { contains: name_from_filename, mode: 'insensitive' } },
          select: { cc: true, full_name: true, gr_number: true, photograph_url: true, photo_blue_bg_url: true },
          take: 2,
        });

        if (nameCandidates.length === 1) {
          const s = nameCandidates[0];
          const oldGr = s.gr_number ?? null;
          const normalizedOld = oldGr ? normalizeKfGr(oldGr).toUpperCase() : '';
          const normalizedNew = normalizeKfGr(gr).toUpperCase();
          // Only correct if missing or different.
          if (!oldGr || normalizedOld !== normalizedNew) {
            if (!dryRun) {
              await prisma.students.update({
                where: { cc: s.cc },
                data: { gr_number: normalizeKfGr(gr) },
              });
            }
            report.gr_corrected.push({
              file,
              rel_path: rel,
              derived_gr: normalizeKfGr(gr),
              cc: s.cc,
              full_name: s.full_name,
              old_gr_number: oldGr,
              new_gr_number: normalizeKfGr(gr),
            });
          }
          candidates = [s];
        } else if (nameCandidates.length > 1) {
          candidates = nameCandidates; // will be treated as ambiguous below
        }
      }

      if (candidates.length !== 1) {
        report.not_found_in_db.push({
          file,
          rel_path: rel,
          gr,
          name_from_filename,
          reason: candidates.length === 0 ? 'NOT_FOUND' : 'AMBIGUOUS_MATCH',
        });
        continue;
      }

      const student = candidates[0];
      const existingUrl = (dbField === 'photo_blue_bg_url' ? student.photo_blue_bg_url : student.photograph_url) || '';
      if (existingUrl) {
        report.skipped_existing_photo.push({
          file,
          rel_path: rel,
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
          rel_path: rel,
          gr,
          cc: student.cc,
          full_name: student.full_name,
          url: '(dry-run)',
        });
        continue;
      }

      const buffer = await fs.readFile(abs);
      const ext = path.extname(file).toLowerCase().replace('.', '') || 'jpg';
      const key = `media/students/${student.cc}/${type}-${Date.now()}.${ext}`;
      const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';

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

      report.uploaded.push({ file, rel_path: rel, gr, cc: student.cc, full_name: student.full_name, url });
    } catch (e: any) {
      report.errors.push({ file, rel_path: rel, gr: gr || undefined, message: e?.message || 'Unknown error' });
    }
  }

  report.totals.uploaded = report.uploaded.length;
  report.totals.skipped_existing_photo = report.skipped_existing_photo.length;
  report.totals.not_found_in_db = report.not_found_in_db.length;
  report.totals.no_gr_in_filename = report.no_gr_in_filename.length;
  report.totals.gr_corrected = report.gr_corrected.length;
  report.totals.errors = report.errors.length;
  report.finished_at = new Date().toISOString();

  const outDir = path.join(process.cwd(), 'scripts', 'out');
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `kaneez-fatima-photos-report-${nowStamp()}${dryRun ? '-dryrun' : ''}.json`);
  await fs.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');

  // eslint-disable-next-line no-console
  console.log(
    [
      `root=${root}`,
      `campus_codes=${campus_codes.join(',')}`,
      `campus_ids=${campusIds.join(',')}`,
      `type=${type}`,
      `dry_run=${dryRun}`,
      `files_seen=${report.totals.files_seen}`,
      `images_considered=${report.totals.images_considered}`,
      `uploaded=${report.totals.uploaded}`,
      `skipped_existing_photo=${report.totals.skipped_existing_photo}`,
      `not_found_in_db=${report.totals.not_found_in_db}`,
      `no_gr_in_filename=${report.totals.no_gr_in_filename}`,
      `duplicate_gr_in_folder=${report.totals.duplicate_gr_in_folder}`,
      `gr_corrected=${report.totals.gr_corrected}`,
      `errors=${report.totals.errors}`,
      `report=${outPath}`,
    ].join(' | '),
  );

  await prisma.$disconnect();

  if (report.errors.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});

