/**
 * TAFSD-483 — import a batch of retaken student photos from a local folder tree
 * (the 2026 photo-day Drive export) into Spaces + the photo history.
 *
 * Filenames in this batch are "<NAME> <GR>.jpg" and the GR series depends on the
 * campus, which is given by the top-level folder:
 *
 *   G-K-F            → Kaneez Fatima, GR "KF-A<n>"
 *   NORTH            → North Nazimabad, GR "A-N<n>"
 *   A LEVEL          → Johar, GR "A-<n>" (falls back to plain "<n>")
 *   everything else  → Johar, GR "<n>"
 *
 * A file only counts as MATCHED when the GR resolves to exactly one student AND
 * the name in the filename agrees with that student's name. Everything else is
 * reported for a human to look at and is never uploaded.
 *
 * Folders named OLD / EXTRA (any depth) are skipped, as agreed on the ticket.
 *
 * Nothing is overwritten: each photo is a new object, becomes `photograph_url`,
 * and gets a `student_photo_history` row, so the previous photo stays in the
 * history. A photo whose bytes are already in the student's history is skipped,
 * so the script is safe to re-run.
 *
 * Usage:
 *   npx ts-node scripts/import-student-photo-retakes.ts --root "/path/to/files"          # dry run (default)
 *   npx ts-node scripts/import-student-photo-retakes.ts --root "/path/to/files" --apply  # upload + write DB
 *
 * Reports: scripts/out/photo-retakes-<stamp>[-dryrun].{json,csv}
 */
import { PrismaClient } from '@prisma/client';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  mimeForExtension,
  photoContentHash,
  studentPhotoKey,
  urlHasContentHash,
} from '../src/modules/media/student-photo-key.util';

const UPLOADED_BY = 'bulk-import:TAFSD-483';
const SKIP_DIR = /^(old|extra)$|\bold\b/i;

type Status =
  | 'matched'
  | 'already_uploaded'
  | 'uploaded'
  | 'name_mismatch'
  | 'gr_not_found'
  | 'gr_ambiguous'
  | 'no_gr_in_filename'
  | 'student_not_enrolled'
  | 'duplicate_student'
  | 'error';

interface Row {
  file: string;
  campus: string;
  name_in_file: string;
  gr_in_file: string | null;
  status: Status;
  cc?: number;
  db_gr?: string | null;
  db_name?: string;
  db_status?: string;
  db_class?: string | null;
  db_section?: string | null;
  name_score?: number;
  url?: string;
  note?: string;
}

interface CampusRule {
  label: string;
  campusCode: string;
  grCandidates: (n: number) => string[];
}

function ruleForTopFolder(top: string): CampusRule {
  const t = top.toUpperCase().replace(/\s+/g, ' ').trim();
  if (t === 'G-K-F') return { label: 'KNF', campusCode: 'KNF', grCandidates: (n) => [`KF-A${n}`] };
  if (t === 'NORTH') return { label: 'NNZ', campusCode: 'NNZ', grCandidates: (n) => [`A-N${n}`] };
  if (t === 'A LEVEL') return { label: 'GEJ A-Level', campusCode: 'GEJ', grCandidates: (n) => [`A-${n}`, `${n}`] };
  return { label: 'GEJ', campusCode: 'GEJ', grCandidates: (n) => [`${n}`] };
}

function normGr(gr: string): string {
  // "KF-A007" / "kf-a7" / "A-N016" → canonical prefix + integer
  const m = gr.trim().toUpperCase().replace(/\s+/g, '').match(/^(.*?)(\d+)$/);
  return m ? `${m[1]}${parseInt(m[2], 10)}` : gr.trim().toUpperCase();
}

function tokens(name: string): string[] {
  return name
    .toUpperCase()
    .replace(/[^A-Z\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !['MUHAMMAD', 'MOHAMMAD', 'MOHAMMED', 'MUHAMMED', 'SYED', 'SYEDA', 'BIN', 'BINT'].includes(t));
}

/** Share of the filename's meaningful name words found in the DB name (0..1). */
function nameScore(fileName: string, dbName: string): number {
  const a = tokens(fileName);
  const b = new Set(tokens(dbName));
  if (!a.length) return 0;
  return a.filter((t) => b.has(t) || [...b].some((x) => x.length > 3 && (x.startsWith(t) || t.startsWith(x)))).length / a.length;
}

function parseFilename(file: string): { name: string; gr: number | null } {
  const base = path.basename(file, path.extname(file)).replace(/\s+/g, ' ').trim();
  const m = base.match(/^(.*?)[\s-]*(\d{1,6})$/);
  if (m) return { name: m[1].trim(), gr: parseInt(m[2], 10) };
  return { name: base, gr: null };
}

async function walk(root: string, rel: string[] = []): Promise<string[][]> {
  const out: string[][] = [];
  for (const e of await fs.readdir(path.join(root, ...rel), { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIR.test(e.name)) continue;
      out.push(...(await walk(root, [...rel, e.name])));
    } else if (/\.(jpe?g|png)$/i.test(e.name)) {
      out.push([...rel, e.name]);
    }
  }
  return out;
}

function spacesFromEnv() {
  const need = (k: string) => {
    const v = (process.env[k] || '').trim();
    if (!v) throw new Error(`Missing env ${k}`);
    return v;
  };
  const region = need('DO_SPACES_REGION');
  const bucket = need('DO_SPACES_BUCKET');
  const regionEndpoint = `https://${region}.digitaloceanspaces.com`;
  const endpointInput = (process.env.DO_SPACES_ENDPOINT || '').trim().replace(/\/+$/, '') || regionEndpoint;
  const host = (() => { try { return new URL(endpointInput).host.toLowerCase(); } catch { return ''; } })();
  const bucketQualified = host.startsWith(`${bucket.toLowerCase()}.`);
  const uploadEndpoint = bucketQualified ? regionEndpoint : endpointInput;
  const cdn = (process.env.DO_SPACES_CDN_ENDPOINT || `${uploadEndpoint}/${bucket}`).trim().replace(/\/+$/, '');
  const client = new S3Client({
    region,
    endpoint: uploadEndpoint,
    credentials: { accessKeyId: need('DO_SPACES_KEY'), secretAccessKey: need('DO_SPACES_SECRET') },
    forcePathStyle: bucketQualified,
  });
  return { client, bucket, cdn };
}

function toCsv(rows: Row[]): string {
  const cols: (keyof Row)[] = ['status', 'file', 'campus', 'name_in_file', 'gr_in_file', 'cc', 'db_gr', 'db_name', 'db_status', 'db_class', 'db_section', 'name_score', 'note', 'url'];
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const root = argv[argv.indexOf('--root') + 1];
  const apply = argv.includes('--apply');
  if (!argv.includes('--root') || !root) throw new Error('Usage: --root "/path/to/files" [--apply]');

  const prisma = new PrismaClient();
  const campuses = await prisma.campuses.findMany({ select: { id: true, campus_code: true } });
  const campusId = new Map(campuses.map((c) => [c.campus_code.toUpperCase(), c.id]));

  const students = await prisma.students.findMany({
    where: { deleted_at: null, gr_number: { not: null } },
    select: {
      cc: true, gr_number: true, full_name: true, status: true, campus_id: true,
      classes: { select: { description: true } },
      sections: { select: { description: true } },
    },
  });
  // campus id → normalised GR → students
  const index = new Map<string, typeof students>();
  for (const s of students) {
    const k = `${s.campus_id}|${normGr(s.gr_number!)}`;
    index.set(k, [...(index.get(k) ?? []), s]);
  }

  const files = await walk(root);
  const rows: Row[] = [];

  for (const parts of files) {
    const rel = parts.join('/');
    const rule = ruleForTopFolder(parts[0]);
    const { name, gr } = parseFilename(parts[parts.length - 1]);
    const row: Row = { file: rel, campus: rule.label, name_in_file: name, gr_in_file: gr == null ? null : String(gr), status: 'gr_not_found' };
    rows.push(row);

    if (gr == null) { row.status = 'no_gr_in_filename'; continue; }
    const cid = campusId.get(rule.campusCode);
    let hits: typeof students = [];
    for (const cand of rule.grCandidates(gr)) {
      hits = index.get(`${cid}|${normGr(cand)}`) ?? [];
      if (hits.length) break;
    }
    if (!hits.length) continue;
    if (hits.length > 1) {
      // Prefer the one whose name agrees, if exactly one does.
      const agreeing = hits.filter((h) => nameScore(name, h.full_name) >= 0.5);
      if (agreeing.length !== 1) { row.status = 'gr_ambiguous'; row.note = hits.map((h) => `${h.cc}:${h.full_name}`).join(' | '); continue; }
      hits = agreeing;
    }
    const s = hits[0];
    Object.assign(row, {
      cc: s.cc, db_gr: s.gr_number, db_name: s.full_name, db_status: String(s.status),
      db_class: s.classes?.description ?? null, db_section: s.sections?.description ?? null,
      name_score: Math.round(nameScore(name, s.full_name) * 100) / 100,
    });
    if (row.name_score! < 0.5) { row.status = 'name_mismatch'; continue; }
    if (String(s.status) !== 'ENROLLED') { row.status = 'student_not_enrolled'; continue; }
    row.status = 'matched';
  }

  // One photo per student per batch — if two files land on the same student, a human picks.
  const byCc = new Map<number, Row[]>();
  for (const r of rows) if (r.status === 'matched') byCc.set(r.cc!, [...(byCc.get(r.cc!) ?? []), r]);
  for (const group of byCc.values()) {
    if (group.length > 1) for (const r of group) { r.status = 'duplicate_student'; r.note = group.map((g) => g.file).join(' | '); }
  }

  // Already imported? (same bytes already in the student's history)
  const matched = rows.filter((r) => r.status === 'matched');
  const history = await prisma.student_photo_history.findMany({
    where: { student_id: { in: matched.map((r) => r.cc!) } },
    select: { student_id: true, url: true },
  });
  const histByCc = new Map<number, string[]>();
  for (const h of history) histByCc.set(h.student_id, [...(histByCc.get(h.student_id) ?? []), h.url]);

  const spaces = apply ? spacesFromEnv() : null;
  let done = 0;
  for (const r of matched) {
    const buf = await fs.readFile(path.join(root, r.file));
    const hash = photoContentHash(buf);
    const prior = (histByCc.get(r.cc!) ?? []).find((u) => urlHasContentHash(u, hash));
    if (prior) { r.status = 'already_uploaded'; r.url = prior; continue; }
    if (!spaces) continue;
    try {
      const ext = path.extname(r.file).slice(1).toLowerCase() || 'jpg';
      const key = studentPhotoKey(r.cc!, 'standard', ext, hash);
      await spaces.client.send(new PutObjectCommand({
        Bucket: spaces.bucket, Key: key, Body: buf, ContentType: mimeForExtension(ext), ACL: 'public-read',
      }));
      const url = `${spaces.cdn}/${key}`;
      await prisma.$transaction([
        prisma.students.update({ where: { cc: r.cc! }, data: { photograph_url: url } }),
        prisma.student_photo_history.create({
          data: { student_id: r.cc!, url, photo_type: 'standard', uploaded_by: UPLOADED_BY, uploaded_at: new Date() },
        }),
        prisma.audit_logs.create({
          data: {
            entity_type: 'STUDENT', entity_id: String(r.cc), action: 'UPDATED', field: 'photograph_url',
            changed_by: UPLOADED_BY, student_id: r.cc!,
            note: `Photo retake import (TAFSD-483) from "${r.file}". Previous photo kept in history.`,
          },
        }),
      ]);
      r.status = 'uploaded';
      r.url = url;
      if (++done % 50 === 0) console.log(`uploaded ${done}/${matched.length}`);
    } catch (e: any) {
      r.status = 'error';
      r.note = e?.message || String(e);
    }
  }

  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(process.cwd(), 'scripts', 'out');
  await fs.mkdir(outDir, { recursive: true });
  const base = path.join(outDir, `photo-retakes-${stamp}${apply ? '' : '-dryrun'}`);
  const order: Status[] = ['error', 'name_mismatch', 'gr_ambiguous', 'duplicate_student', 'student_not_enrolled', 'gr_not_found', 'no_gr_in_filename', 'matched', 'already_uploaded', 'uploaded'];
  rows.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.file.localeCompare(b.file));
  await fs.writeFile(`${base}.json`, JSON.stringify({ root, apply, counts, rows }, null, 2));
  await fs.writeFile(`${base}.csv`, toCsv(rows));

  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — ${files.length} photos`);
  console.log(counts);
  console.log(`report: ${base}.csv`);
  await prisma.$disconnect();
  if (counts.error) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e?.stack || e);
  process.exit(1);
});
