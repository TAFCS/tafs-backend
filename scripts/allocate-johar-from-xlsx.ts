/**
 * Johar section allocation from STUDENT PROFILE 2026-2027 JULY 25.xlsx
 *
 * Same rules as GKF:
 * - Match by C.C. #
 * - If DB class ≠ sheet class → flag only (never change class)
 * - If DB class matches → set section only (leave house alone)
 * - Skip QUIT / EX* sheets
 *
 * Usage:
 *   npx ts-node scripts/allocate-johar-from-xlsx.ts --dry-run
 *   npx ts-node scripts/allocate-johar-from-xlsx.ts --dry-run --class=NUR
 *   npx ts-node scripts/allocate-johar-from-xlsx.ts --apply --class=NUR
 */

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import ExcelJS from 'exceljs';
import dotenv from 'dotenv';

dotenv.config();

let dbUrl = process.env.DATABASE_URL || '';
if (dbUrl && !dbUrl.includes('connection_limit')) {
  dbUrl += (dbUrl.includes('?') ? '&' : '?') + 'connection_limit=1';
}

const prisma = new PrismaClient({
  datasources: { db: { url: dbUrl } },
});

const JOHAR_CAMPUS_ID = 1;
const DEFAULT_XLSX =
  '/Users/air/Downloads/STUDENT PROFILE 2026-2027 JULY 25.xlsx';

/** Never apply these CCs (known sheet typos / wrong-campus collisions). */
const SKIP_APPLY_CCS = new Set<number>([
  7973, // sheet NUR B "DANIA BATOOL" but DB is GKF Zimal Fatima
]);

/** Ordered longest-first so "JR. III" wins over "JR. I" etc. */
const CLASS_PATTERNS: { re: RegExp; classCode: string; label: string }[] = [
  { re: /^PRE-?NURSERY|^PN\b/i, classCode: 'PN', label: 'Pre-Nursery' },
  { re: /^NURSERY|^NUR\b/i, classCode: 'NUR', label: 'Nursery' },
  { re: /^KG\b|^K\.?G\.?\b/i, classCode: 'KG', label: 'KG' },
  { re: /^JR\.?\s*III\b|^JRIII\b/i, classCode: 'JRIII', label: 'JR. III' },
  { re: /^JR\.?\s*II\b|^JRII\b/i, classCode: 'JRII', label: 'JR. II' },
  { re: /^JR\.?\s*IV\b|^JRIV\b/i, classCode: 'JRIV', label: 'JR. IV' },
  { re: /^JR\.?\s*V\b|^JRV\b/i, classCode: 'JRV', label: 'JR. V' },
  { re: /^JR\.?\s*I\b|^JRI\b/i, classCode: 'JRI', label: 'JR. I' },
  { re: /^SR\.?\s*III\b|^SRIII\b/i, classCode: 'SRIII', label: 'SR. III' },
  { re: /^SR\.?\s*II\b|^SRII\b/i, classCode: 'SRII', label: 'SR. II' },
  { re: /^SR\.?\s*I\b|^SRI\b/i, classCode: 'SRI', label: 'SR. I' },
  { re: /^O-?III\b|^OIII\b/i, classCode: 'OIII', label: 'O-III' },
  { re: /^O-?II\b|^OII\b/i, classCode: 'OII', label: 'O-II' },
  { re: /^O-?I\b|^OI\b/i, classCode: 'OI', label: 'O-I' },
  { re: /^VIII\b/i, classCode: 'VIII', label: 'VIII' },
  { re: /^VII\b/i, classCode: 'VII', label: 'VII' },
  { re: /^IX\b/i, classCode: 'IX', label: 'IX' },
  { re: /^X\b/i, classCode: 'X', label: 'X' },
];

type Outcome =
  | 'missing'
  | 'class_mismatch'
  | 'already_correct'
  | 'would_set_section'
  | 'applied'
  | 'apply_failed'
  | 'skipped_sheet';

interface SheetSpec {
  sheetName: string;
  classCode: string;
  sheetClassLabel: string;
  targetSectionLetter: string;
  classKey: string;
}

interface SheetStudent {
  sheetName: string;
  classKey: string;
  sheetClassLabel: string;
  classCode: string;
  targetSectionLetter: string;
  cc: number;
  gr: string;
  name: string;
}

interface RowResult {
  outcome: Outcome;
  sheet: SheetStudent;
  dbName?: string;
  dbClassCode?: string | null;
  dbClassDesc?: string | null;
  dbSection?: string | null;
  dbCampusId?: number | null;
  dbStatus?: string;
  targetClassId?: number;
  targetSectionId?: number;
  note?: string;
  error?: string;
}

function parseArgs(argv: string[]) {
  const apply = argv.includes('--apply');
  const dryRun = !apply;
  const exportDiff = true;
  let classFilter: string | null = null;
  let xlsxPath = DEFAULT_XLSX;
  for (const a of argv) {
    if (a.startsWith('--class=')) {
      classFilter = a
        .slice('--class='.length)
        .toUpperCase()
        .replace(/\./g, '')
        .replace(/\s+/g, '')
        .replace(/-/g, '');
    }
    if (a.startsWith('--xlsx=')) xlsxPath = a.slice('--xlsx='.length);
  }
  return { dryRun, apply, exportDiff, classFilter, xlsxPath };
}

function shouldSkipSheet(name: string): boolean {
  const n = name.trim().toUpperCase();
  if (n.includes('QUIT')) return true;
  if (n.startsWith('EX ') || n.startsWith('EX-') || n.startsWith('EX_')) return true;
  return false;
}

function parseSheetSpec(sheetName: string): SheetSpec | null {
  if (shouldSkipSheet(sheetName)) return null;
  const raw = sheetName.trim().replace(/\s+/g, ' ');
  // Strip trailing discipline suffixes for matching class, keep section letter
  // e.g. "O-I A ENG", "O-I B BIO & COMM"
  let matched: { classCode: string; label: string; rest: string } | null = null;
  for (const p of CLASS_PATTERNS) {
    const m = raw.match(p.re);
    if (m && m.index === 0) {
      matched = {
        classCode: p.classCode,
        label: p.label,
        rest: raw.slice(m[0].length).trim(),
      };
      break;
    }
  }
  if (!matched) return null;

  const secMatch = matched.rest.match(/^([A-D])\b/i);
  const targetSectionLetter = (secMatch ? secMatch[1] : 'A').toUpperCase();
  const classKey = `${matched.classCode}_${targetSectionLetter}`;

  return {
    sheetName,
    classCode: matched.classCode,
    sheetClassLabel: `${matched.label} ${targetSectionLetter}`,
    targetSectionLetter,
    classKey,
  };
}

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v).trim();
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object' && 'text' in v && typeof (v as any).text === 'string') return String((v as any).text).trim();
  if (typeof v === 'object' && 'result' in v) return cellText((v as any).result);
  if (typeof v === 'object' && 'richText' in v) {
    return ((v as any).richText as { text: string }[]).map((r) => r.text).join('').trim();
  }
  return String(v).trim();
}

async function parseWorkbook(xlsxPath: string, classFilter: string | null): Promise<{
  students: SheetStudent[];
  specs: SheetSpec[];
  skipped: string[];
  unrecognized: string[];
}> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);
  const students: SheetStudent[] = [];
  const specs: SheetSpec[] = [];
  const skipped: string[] = [];
  const unrecognized: string[] = [];

  for (const ws of wb.worksheets) {
    const name = ws.name;
    if (shouldSkipSheet(name)) {
      skipped.push(name);
      continue;
    }
    const spec = parseSheetSpec(name);
    if (!spec) {
      unrecognized.push(name);
      continue;
    }
    if (classFilter) {
      const codeNorm = spec.classCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (codeNorm !== classFilter && !classFilter.startsWith(codeNorm)) {
        // allow NUR or NUR_A style
        const keyNorm = spec.classKey.replace(/_/g, '');
        if (keyNorm !== classFilter && !keyNorm.startsWith(classFilter)) continue;
      }
    }
    specs.push(spec);

    let headerRow = 0;
    const colIndex: Record<string, number> = {};
    ws.eachRow((row, rowNumber) => {
      if (headerRow) return;
      const vals: string[] = [];
      row.eachCell({ includeEmpty: false }, (cell, col) => {
        vals[col] = cellText(cell.value).toUpperCase();
      });
      if (vals.join('|').includes('C.C')) {
        headerRow = rowNumber;
        row.eachCell({ includeEmpty: false }, (cell, col) => {
          const h = cellText(cell.value).toUpperCase().replace(/\s+/g, ' ').trim();
          if (h.includes('C.C')) colIndex.cc = col;
          else if (h.includes('G.R')) colIndex.gr = col;
          else if (h.includes('STUDENT') && h.includes('NAME')) colIndex.name = col;
        });
      }
    });

    if (!headerRow || !colIndex.cc || !colIndex.name) {
      console.warn(`No header on sheet ${JSON.stringify(name)}`);
      continue;
    }

    ws.eachRow((row, rowNumber) => {
      if (rowNumber <= headerRow) return;
      const ccRaw = cellText(row.getCell(colIndex.cc).value);
      const studentName = cellText(row.getCell(colIndex.name).value);
      if (!ccRaw || !studentName) return;
      const cc = parseInt(ccRaw.replace(/[^\d]/g, ''), 10);
      if (!Number.isFinite(cc) || cc <= 0) return;
      students.push({
        sheetName: spec.sheetName,
        classKey: spec.classKey,
        sheetClassLabel: spec.sheetClassLabel,
        classCode: spec.classCode,
        targetSectionLetter: spec.targetSectionLetter,
        cc,
        gr: colIndex.gr ? cellText(row.getCell(colIndex.gr).value) : '',
        name: studentName,
      });
    });
  }

  return { students, specs, skipped, unrecognized };
}

async function loadRefs() {
  const [classes, sections, campuses] = await Promise.all([
    prisma.classes.findMany({ select: { id: true, class_code: true, description: true } }),
    prisma.sections.findMany({ select: { id: true, description: true } }),
    prisma.campuses.findMany({ select: { id: true, campus_code: true, campus_name: true } }),
  ]);
  const classByCode = new Map(classes.map((c) => [c.class_code.toUpperCase(), c]));
  const classById = new Map(classes.map((c) => [c.id, c]));
  const sectionByLetter = new Map(
    sections.map((s) => [s.description.trim().toUpperCase(), s]),
  );
  return { classByCode, classById, sectionByLetter, campuses };
}

function normalizeName(s: string): string {
  return s.toUpperCase().replace(/\s+/g, ' ').trim();
}

async function evaluate(
  rows: SheetStudent[],
  refs: Awaited<ReturnType<typeof loadRefs>>,
): Promise<RowResult[]> {
  const ccs = [...new Set(rows.map((r) => r.cc))];
  const students = await prisma.students.findMany({
    where: { cc: { in: ccs } },
    select: {
      cc: true,
      full_name: true,
      gr_number: true,
      status: true,
      campus_id: true,
      class_id: true,
      section_id: true,
      house_id: true,
    },
  });
  const byCc = new Map(students.map((s) => [s.cc, s]));
  const results: RowResult[] = [];

  for (const sheet of rows) {
    const targetClass = refs.classByCode.get(sheet.classCode.toUpperCase());
    const targetSection = refs.sectionByLetter.get(sheet.targetSectionLetter.toUpperCase());
    if (!targetClass || !targetSection) {
      results.push({
        outcome: 'apply_failed',
        sheet,
        note: `Missing ref: class=${sheet.classCode} section=${sheet.targetSectionLetter}`,
      });
      continue;
    }

    const db = byCc.get(sheet.cc);
    if (!db) {
      results.push({
        outcome: 'missing',
        sheet,
        targetClassId: targetClass.id,
        targetSectionId: targetSection.id,
        note: 'CC not found in DB',
      });
      continue;
    }

    const dbClass = db.class_id != null ? refs.classById.get(db.class_id) : null;
    const dbSection =
      db.section_id != null
        ? [...refs.sectionByLetter.values()].find((s) => s.id === db.section_id) ?? null
        : null;

    if (db.class_id !== targetClass.id) {
      results.push({
        outcome: 'class_mismatch',
        sheet,
        dbName: db.full_name,
        dbClassCode: dbClass?.class_code ?? null,
        dbClassDesc: dbClass?.description ?? null,
        dbSection: dbSection?.description ?? null,
        dbCampusId: db.campus_id,
        dbStatus: db.status,
        targetClassId: targetClass.id,
        targetSectionId: targetSection.id,
        note: `Sheet class ${sheet.classCode} ≠ DB class ${dbClass?.class_code ?? 'NULL'}`,
      });
      continue;
    }

    const nameNote =
      normalizeName(db.full_name) !== normalizeName(sheet.name)
        ? `Name differs: sheet="${sheet.name}" db="${db.full_name}"`
        : undefined;
    const campusNote =
      db.campus_id !== JOHAR_CAMPUS_ID
        ? `campus ${db.campus_id ?? 'NULL'} → ${JOHAR_CAMPUS_ID}`
        : null;

    if (db.section_id === targetSection.id) {
      results.push({
        outcome: 'already_correct',
        sheet,
        dbName: db.full_name,
        dbClassCode: dbClass?.class_code ?? null,
        dbClassDesc: dbClass?.description ?? null,
        dbSection: dbSection?.description ?? null,
        dbCampusId: db.campus_id,
        dbStatus: db.status,
        targetClassId: targetClass.id,
        targetSectionId: targetSection.id,
        note: [campusNote, nameNote].filter(Boolean).join('; ') || undefined,
      });
      continue;
    }

    results.push({
      outcome: 'would_set_section',
      sheet,
      dbName: db.full_name,
      dbClassCode: dbClass?.class_code ?? null,
      dbClassDesc: dbClass?.description ?? null,
      dbSection: dbSection?.description ?? null,
      dbCampusId: db.campus_id,
      dbStatus: db.status,
      targetClassId: targetClass.id,
      targetSectionId: targetSection.id,
      note: [
        `section ${dbSection?.description ?? 'NULL'} → ${sheet.targetSectionLetter}`,
        campusNote,
        nameNote,
      ]
        .filter(Boolean)
        .join('; '),
    });
  }
  return results;
}

async function applyResults(results: RowResult[]): Promise<RowResult[]> {
  const out: RowResult[] = [];
  for (const r of results) {
    if (r.outcome !== 'would_set_section') {
      out.push(r);
      continue;
    }
    if (SKIP_APPLY_CCS.has(r.sheet.cc)) {
      out.push({
        ...r,
        outcome: 'apply_failed',
        note: [r.note, 'SKIPPED: in SKIP_APPLY_CCS'].filter(Boolean).join('; '),
        error: 'skipped',
      });
      continue;
    }
    // Do not pull students from other campuses onto Johar via this script
    if (r.dbCampusId != null && r.dbCampusId !== JOHAR_CAMPUS_ID) {
      out.push({
        ...r,
        outcome: 'apply_failed',
        note: [r.note, 'SKIPPED: non-Johar campus'].filter(Boolean).join('; '),
        error: 'skipped_other_campus',
      });
      continue;
    }
    try {
      const data: { section_id: number; campus_id?: number } = {
        section_id: r.targetSectionId!,
      };
      if (r.dbCampusId == null) {
        data.campus_id = JOHAR_CAMPUS_ID;
      }
      await prisma.students.update({
        where: { cc: r.sheet.cc },
        data,
      });
      out.push({ ...r, outcome: 'applied' });
    } catch (e: any) {
      out.push({ ...r, outcome: 'apply_failed', error: e?.message ?? String(e) });
    }
  }
  return out;
}

function printSummary(results: RowResult[], specs: SheetSpec[]) {
  const byKey = new Map<string, RowResult[]>();
  for (const r of results) {
    const k = r.sheet.classKey;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(r);
  }

  console.log('\n========== JOHAR DRY-RUN / RESULT SUMMARY ==========\n');

  const seen = new Set<string>();
  for (const spec of specs) {
    if (seen.has(spec.classKey)) continue;
    seen.add(spec.classKey);
    const rows = byKey.get(spec.classKey) ?? [];
    if (!rows.length) continue;
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
    console.log(
      `${spec.sheetClassLabel} (${spec.sheetName.trim()}) → section ${spec.targetSectionLetter}  n=${rows.length}`,
    );
    console.log(
      `  would_set=${counts.would_set_section ?? 0}  already=${counts.already_correct ?? 0}  class_mismatch=${counts.class_mismatch ?? 0}  missing=${counts.missing ?? 0}  applied=${counts.applied ?? 0}  failed=${counts.apply_failed ?? 0}`,
    );

    const mismatches = rows.filter((r) => r.outcome === 'class_mismatch');
    if (mismatches.length && mismatches.length <= 25) {
      for (const r of mismatches) {
        console.log(
          `    MISMATCH CC ${r.sheet.cc} sheet=${r.sheet.name} (${r.sheet.classCode}) db=${r.dbName} (${r.dbClassCode ?? 'NULL'}/${r.dbSection ?? 'NULL'})`,
        );
      }
    } else if (mismatches.length > 25) {
      console.log(`    (${mismatches.length} class mismatches — see diff workbook)`);
    }

    const missing = rows.filter((r) => r.outcome === 'missing');
    if (missing.length && missing.length <= 15) {
      for (const r of missing) console.log(`    MISSING CC ${r.sheet.cc} ${r.sheet.name}`);
    } else if (missing.length > 15) {
      console.log(`    (${missing.length} missing — see diff workbook)`);
    }

    const would = rows.filter((r) => r.outcome === 'would_set_section' || r.outcome === 'applied');
    if (would.length && would.length <= 20) {
      for (const r of would) {
        console.log(
          `    SECTION CC ${r.sheet.cc} ${r.dbName ?? r.sheet.name} ${r.dbSection ?? 'NULL'} → ${r.sheet.targetSectionLetter} [${r.outcome}]`,
        );
      }
    } else if (would.length > 20) {
      console.log(`    (${would.length} section updates — see diff workbook)`);
    }
    console.log('');
  }

  const byCc = new Map<number, SheetStudent[]>();
  for (const r of results) {
    if (!byCc.has(r.sheet.cc)) byCc.set(r.sheet.cc, []);
    byCc.get(r.sheet.cc)!.push(r.sheet);
  }
  const dups = [...byCc.entries()].filter(([, v]) => v.length > 1);
  if (dups.length) {
    console.log(`DUPLICATE CCs ACROSS SHEETS: ${dups.length}`);
    for (const [cc, sheets] of dups.slice(0, 30)) {
      console.log(
        `  CC ${cc}: ` + sheets.map((s) => `${s.sheetName.trim()}/${s.name}`).join(' | '),
      );
    }
    if (dups.length > 30) console.log(`  ... and ${dups.length - 30} more`);
    console.log('');
  }

  const totals: Record<string, number> = {};
  for (const r of results) totals[r.outcome] = (totals[r.outcome] ?? 0) + 1;
  console.log('TOTALS', totals);
}

async function exportDiff(results: RowResult[], outDir: string) {
  const wb = new ExcelJS.Workbook();
  const mismatch = wb.addWorksheet('class_mismatch');
  const missing = wb.addWorksheet('missing');
  const sectionUpdates = wb.addWorksheet('section_updates');
  const already = wb.addWorksheet('already_correct');
  const all = wb.addWorksheet('all_rows');
  const dups = wb.addWorksheet('duplicate_ccs');

  const headers = [
    'cc',
    'sheet_name',
    'sheet_class',
    'sheet_section_target',
    'sheet_gr',
    'sheet_student_name',
    'db_name',
    'db_class_code',
    'db_class_desc',
    'db_section',
    'db_campus_id',
    'db_status',
    'outcome',
    'note',
    'error',
  ];
  for (const ws of [mismatch, missing, sectionUpdates, already, all]) ws.addRow(headers);

  const push = (ws: ExcelJS.Worksheet, r: RowResult) => {
    ws.addRow([
      r.sheet.cc,
      r.sheet.sheetName,
      r.sheet.sheetClassLabel,
      r.sheet.targetSectionLetter,
      r.sheet.gr,
      r.sheet.name,
      r.dbName ?? '',
      r.dbClassCode ?? '',
      r.dbClassDesc ?? '',
      r.dbSection ?? '',
      r.dbCampusId ?? '',
      r.dbStatus ?? '',
      r.outcome,
      r.note ?? '',
      r.error ?? '',
    ]);
  };

  for (const r of results) {
    push(all, r);
    if (r.outcome === 'class_mismatch') push(mismatch, r);
    if (r.outcome === 'missing') push(missing, r);
    if (r.outcome === 'would_set_section' || r.outcome === 'applied') push(sectionUpdates, r);
    if (r.outcome === 'already_correct') push(already, r);
  }

  dups.addRow(['cc', 'sheet_name', 'sheet_class', 'sheet_section', 'sheet_gr', 'sheet_name_student']);
  const byCc = new Map<number, SheetStudent[]>();
  for (const r of results) {
    if (!byCc.has(r.sheet.cc)) byCc.set(r.sheet.cc, []);
    byCc.get(r.sheet.cc)!.push(r.sheet);
  }
  for (const [cc, sheets] of [...byCc.entries()].filter(([, v]) => v.length > 1)) {
    for (const s of sheets) {
      dups.addRow([cc, s.sheetName, s.sheetClassLabel, s.targetSectionLetter, s.gr, s.name]);
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(outDir, `johar-allocation-dry-run-${stamp}.xlsx`);
  await wb.xlsx.writeFile(outPath);
  console.log(`\nWrote diff workbook: ${outPath}`);
  return outPath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log('Mode:', args.apply ? 'APPLY' : 'DRY-RUN', '| campus: Johar (1) | class filter:', args.classFilter ?? 'ALL');
  console.log('XLSX:', args.xlsxPath);

  if (!fs.existsSync(args.xlsxPath)) {
    console.error('XLSX not found');
    process.exit(1);
  }

  const refs = await loadRefs();
  console.log(
    'Classes:',
    [...refs.classByCode.entries()].map(([k, v]) => `${k}=${v.id}`).join(', '),
  );
  console.log(
    'Sections:',
    [...refs.sectionByLetter.entries()].map(([k, v]) => `${k}=${v.id}`).join(', '),
  );

  const { students, specs, skipped, unrecognized } = await parseWorkbook(
    args.xlsxPath,
    args.classFilter,
  );
  console.log(`Parsed sheets: ${specs.length} | students: ${students.length}`);
  console.log('Skipped sheets:', skipped.join(' | ') || '(none)');
  if (unrecognized.length) console.log('Unrecognized sheets:', unrecognized.join(' | '));

  let results = await evaluate(students, refs);
  if (args.apply) results = await applyResults(results);
  printSummary(results, specs);

  if (args.exportDiff) {
    const outDir = path.join(__dirname, '../tmp');
    fs.mkdirSync(outDir, { recursive: true });
    await exportDiff(results, outDir);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
