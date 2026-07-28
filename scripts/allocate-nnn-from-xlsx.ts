/**
 * North Nazimabad (NNN) section allocation from STUDENT PROFILE(NNN) 2026-2027.xlsx
 *
 * Same rules as GKF/Johar:
 * - Match by C.C. #
 * - If DB class ≠ sheet class → flag only (never change class)
 * - If DB class matches → set section only (leave house alone)
 * - No section letters in sheets → all target section A
 * - Skip quit / EX* sheets
 *
 * Usage:
 *   npx ts-node scripts/allocate-nnn-from-xlsx.ts --dry-run
 *   npx ts-node scripts/allocate-nnn-from-xlsx.ts --apply --class=NUR
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

const NNN_CAMPUS_ID = 3;
const DEFAULT_XLSX =
  '/Users/air/Downloads/STUDENT PROFILE(NNN) 2026-2027.xlsx';

type ClassKey = 'PN' | 'NUR' | 'KG' | 'JR_I' | 'JR_II' | 'JR_III' | 'JR_IV' | 'JR_V';

interface SheetSpec {
  sheetName: string;
  classKey: ClassKey;
  sheetClassLabel: string;
  classCode: string;
  targetSectionLetter: 'A';
}

const SHEET_SPECS: SheetSpec[] = [
  { sheetName: 'PN', classKey: 'PN', sheetClassLabel: 'Pre-Nursery', classCode: 'PN', targetSectionLetter: 'A' },
  { sheetName: 'NUR', classKey: 'NUR', sheetClassLabel: 'Nursery', classCode: 'NUR', targetSectionLetter: 'A' },
  { sheetName: 'KG', classKey: 'KG', sheetClassLabel: 'KG', classCode: 'KG', targetSectionLetter: 'A' },
  { sheetName: 'JR. I', classKey: 'JR_I', sheetClassLabel: 'JR. I', classCode: 'JRI', targetSectionLetter: 'A' },
  { sheetName: 'JR. II', classKey: 'JR_II', sheetClassLabel: 'JR. II', classCode: 'JRII', targetSectionLetter: 'A' },
  { sheetName: 'JR. III', classKey: 'JR_III', sheetClassLabel: 'JR. III', classCode: 'JRIII', targetSectionLetter: 'A' },
  { sheetName: 'JR. IV', classKey: 'JR_IV', sheetClassLabel: 'JR. IV', classCode: 'JRIV', targetSectionLetter: 'A' },
  { sheetName: 'JR. V', classKey: 'JR_V', sheetClassLabel: 'JR. V', classCode: 'JRV', targetSectionLetter: 'A' },
];

type Outcome =
  | 'missing'
  | 'class_mismatch'
  | 'already_correct'
  | 'would_set_section'
  | 'applied'
  | 'apply_failed';

interface SheetStudent {
  sheetName: string;
  classKey: ClassKey;
  sheetClassLabel: string;
  classCode: string;
  targetSectionLetter: 'A';
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
  let classFilter: ClassKey | null = null;
  let xlsxPath = DEFAULT_XLSX;
  for (const a of argv) {
    if (a.startsWith('--class=')) {
      const raw = a.slice('--class='.length).toUpperCase().replace(/\./g, '_').replace(/\s+/g, '_');
      const map: Record<string, ClassKey> = {
        PN: 'PN',
        NUR: 'NUR',
        KG: 'KG',
        JR_I: 'JR_I',
        JRI: 'JR_I',
        JR_II: 'JR_II',
        JRII: 'JR_II',
        JR_III: 'JR_III',
        JRIII: 'JR_III',
        JR_IV: 'JR_IV',
        JRIV: 'JR_IV',
        JR_V: 'JR_V',
        JRV: 'JR_V',
      };
      classFilter = map[raw] ?? (raw as ClassKey);
    }
    if (a.startsWith('--xlsx=')) xlsxPath = a.slice('--xlsx='.length);
  }
  return { dryRun: !apply, apply, classFilter, xlsxPath };
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

function normalizeName(s: string): string {
  return s.toUpperCase().replace(/\s+/g, ' ').trim();
}

async function parseWorkbook(xlsxPath: string, classFilter: ClassKey | null): Promise<SheetStudent[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);
  const out: SheetStudent[] = [];

  for (const spec of SHEET_SPECS) {
    if (classFilter && spec.classKey !== classFilter) continue;
    const ws =
      wb.getWorksheet(spec.sheetName) ||
      wb.worksheets.find((w) => w.name.trim() === spec.sheetName.trim());
    if (!ws) {
      console.warn(`Sheet not found: ${JSON.stringify(spec.sheetName)}`);
      continue;
    }

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
      console.warn(`Could not find header on sheet ${spec.sheetName}`);
      continue;
    }

    ws.eachRow((row, rowNumber) => {
      if (rowNumber <= headerRow) return;
      const ccRaw = cellText(row.getCell(colIndex.cc).value);
      const name = cellText(row.getCell(colIndex.name).value);
      if (!ccRaw || !name) return;
      const cc = parseInt(ccRaw.replace(/[^\d]/g, ''), 10);
      if (!Number.isFinite(cc) || cc <= 0) return;
      out.push({
        sheetName: spec.sheetName,
        classKey: spec.classKey,
        sheetClassLabel: spec.sheetClassLabel,
        classCode: spec.classCode,
        targetSectionLetter: 'A',
        cc,
        gr: colIndex.gr ? cellText(row.getCell(colIndex.gr).value) : '',
        name,
      });
    });
  }

  return out;
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
    const targetSection = refs.sectionByLetter.get(sheet.targetSectionLetter);
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
      db.campus_id !== NNN_CAMPUS_ID
        ? `campus ${db.campus_id ?? 'NULL'} → ${NNN_CAMPUS_ID}`
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
    if (r.dbCampusId != null && r.dbCampusId !== NNN_CAMPUS_ID) {
      out.push({
        ...r,
        outcome: 'apply_failed',
        note: [r.note, 'SKIPPED: non-NNN campus'].filter(Boolean).join('; '),
        error: 'skipped_other_campus',
      });
      continue;
    }
    try {
      const data: { section_id: number; campus_id?: number } = {
        section_id: r.targetSectionId!,
      };
      if (r.dbCampusId == null) data.campus_id = NNN_CAMPUS_ID;
      await prisma.students.update({ where: { cc: r.sheet.cc }, data });
      out.push({ ...r, outcome: 'applied' });
    } catch (e: any) {
      out.push({ ...r, outcome: 'apply_failed', error: e?.message ?? String(e) });
    }
  }
  return out;
}

function printSummary(results: RowResult[]) {
  const byClass = new Map<string, RowResult[]>();
  for (const r of results) {
    const k = r.sheet.classKey;
    if (!byClass.has(k)) byClass.set(k, []);
    byClass.get(k)!.push(r);
  }

  console.log('\n========== NNN DRY-RUN / RESULT SUMMARY ==========\n');
  for (const spec of SHEET_SPECS) {
    const rows = byClass.get(spec.classKey);
    if (!rows?.length) continue;
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
    console.log(
      `${spec.sheetClassLabel} (${spec.sheetName}) → section ${spec.targetSectionLetter}  n=${rows.length}`,
    );
    console.log(
      `  would_set=${counts.would_set_section ?? 0}  already=${counts.already_correct ?? 0}  class_mismatch=${counts.class_mismatch ?? 0}  missing=${counts.missing ?? 0}  applied=${counts.applied ?? 0}  failed=${counts.apply_failed ?? 0}`,
    );

    for (const r of rows.filter((x) => x.outcome === 'class_mismatch')) {
      console.log(
        `    MISMATCH CC ${r.sheet.cc} sheet=${r.sheet.name} (${r.sheet.classCode}) db=${r.dbName} (${r.dbClassCode ?? 'NULL'}/${r.dbSection ?? 'NULL'}) campus=${r.dbCampusId ?? 'NULL'}`,
      );
    }
    for (const r of rows.filter((x) => x.outcome === 'missing')) {
      console.log(`    MISSING CC ${r.sheet.cc} ${r.sheet.name}`);
    }
    for (const r of rows.filter(
      (x) => x.outcome === 'would_set_section' || x.outcome === 'applied',
    )) {
      console.log(
        `    SECTION CC ${r.sheet.cc} ${r.dbName ?? r.sheet.name} ${r.dbSection ?? 'NULL'} → ${r.sheet.targetSectionLetter} [${r.outcome}]${r.note ? '  ' + r.note : ''}`,
      );
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
    console.log('DUPLICATE CCs ACROSS SHEETS:');
    for (const [cc, sheets] of dups) {
      console.log(
        `  CC ${cc}: ` + sheets.map((s) => `${s.sheetName}/${s.name}`).join(' | '),
      );
    }
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

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(outDir, `nnn-allocation-dry-run-${stamp}.xlsx`);
  await wb.xlsx.writeFile(outPath);
  console.log(`\nWrote diff workbook: ${outPath}`);
  return outPath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    'Mode:',
    args.apply ? 'APPLY' : 'DRY-RUN',
    '| campus: North Nazimabad (3) | class filter:',
    args.classFilter ?? 'ALL',
  );
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
  console.log(
    'Campuses:',
    refs.campuses.map((c) => `${c.id}:${c.campus_code}`).join(', '),
  );

  const rows = await parseWorkbook(args.xlsxPath, args.classFilter);
  console.log(`Parsed ${rows.length} student rows (skipped quit + EX JR. V).`);

  let results = await evaluate(rows, refs);
  if (args.apply) results = await applyResults(results);
  printSummary(results);

  const outDir = path.join(__dirname, '../tmp');
  fs.mkdirSync(outDir, { recursive: true });
  await exportDiff(results, outDir);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
