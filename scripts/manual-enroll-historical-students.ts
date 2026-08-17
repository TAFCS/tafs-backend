/**
 * Bulk-enroll returning students who have no prior digital record.
 * Not a reinstatement: there is no LEFT/EXPELLED row to restore. Creates
 * ENROLLED students with explicit historical CC + GR, opens their first
 * progression period, and logs the action.
 *
 * Usage:
 *   DRY_RUN=true  npx ts-node -r tsconfig-paths/register scripts/manual-enroll-historical-students.ts students.json
 *   DRY_RUN=false npx ts-node -r tsconfig-paths/register scripts/manual-enroll-historical-students.ts students.csv
 *
 * Default is DRY_RUN=true (no writes). Set DRY_RUN=false to commit.
 *
 * Optional env:
 *   ACADEMIC_YEAR=2026-2027
 *   DOA=2026-08-12           (YYYY-MM-DD)
 *   ACTOR=manual-data-entry
 *
 * JSON: array of
 *   { "cc": 7060, "full_name": "MUHAMMAD ABUBAKAR", "gr_number": "A5832",
 *     "classCode": "JRII", "campus_id": 1, "section": "B" }
 *
 * CSV headers (section optional):
 *   cc,full_name,gr_number,classCode,campus_id,section
 */
import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';

const prisma = new PrismaClient();

const ACTOR = process.env.ACTOR || 'manual-data-entry';
const ACADEMIC_YEAR = process.env.ACADEMIC_YEAR || '2026-2027';
const DOA = process.env.DOA ? new Date(process.env.DOA) : new Date();

type Input = {
  cc: number;
  full_name: string;
  gr_number: string;
  classCode: string;
  campus_id: number;
  section: string | null;
};

function usageAndExit(message?: string): never {
  if (message) console.error(message);
  console.error(
    'Usage: DRY_RUN=false npx ts-node -r tsconfig-paths/register scripts/manual-enroll-historical-students.ts <file.json|file.csv>',
  );
  process.exit(1);
}

function requiredString(value: unknown, field: string, rowLabel: string): string {
  const str = String(value ?? '').trim();
  if (!str) throw new Error(`${rowLabel}: missing ${field}`);
  return str;
}

function requiredInt(value: unknown, field: string, rowLabel: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${rowLabel}: ${field} must be a positive integer (got ${JSON.stringify(value)})`);
  }
  return n;
}

function normalizeRow(raw: Record<string, unknown>, index: number): Input {
  const rowLabel = `Row ${index + 1}`;
  const sectionRaw =
    raw.section ?? raw.sectionDescription ?? raw.section_description ?? '';
  const section = String(sectionRaw).trim() || null;
  return {
    cc: requiredInt(raw.cc, 'cc', rowLabel),
    full_name: requiredString(raw.full_name ?? raw.fullName, 'full_name', rowLabel),
    gr_number: requiredString(raw.gr_number ?? raw.grNumber, 'gr_number', rowLabel),
    classCode: requiredString(raw.classCode ?? raw.class_code, 'classCode', rowLabel),
    campus_id: requiredInt(raw.campus_id ?? raw.campusId, 'campus_id', rowLabel),
    section,
  };
}

function loadInputs(filePath: string): Input[] {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    usageAndExit(`File not found: ${abs}`);
  }
  const rawText = fs.readFileSync(abs, 'utf8');
  const ext = path.extname(abs).toLowerCase();

  if (ext === '.json') {
    const parsed = JSON.parse(rawText);
    if (!Array.isArray(parsed)) {
      throw new Error('JSON file must be an array of student objects');
    }
    return parsed.map((row, i) => normalizeRow(row, i));
  }

  if (ext === '.csv') {
    const rows = parse(rawText, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    }) as Record<string, unknown>[];
    return rows.map((row, i) => normalizeRow(row, i));
  }

  usageAndExit(`Unsupported file type "${ext}". Use .json or .csv.`);
}

async function preflight(input: Input): Promise<{ classId: number; sectionId: number | null }> {
  const existing = await prisma.students.findUnique({ where: { cc: input.cc } });
  if (existing) {
    throw new Error(
      `CC ${input.cc} already exists (${existing.full_name}, ${existing.status}) — refusing to overwrite.`,
    );
  }

  const grClash = await prisma.students.findFirst({
    where: {
      campus_id: input.campus_id,
      gr_number: input.gr_number,
      deleted_at: null,
    },
  });
  if (grClash) {
    throw new Error(
      `GR ${input.gr_number} already assigned to CC ${grClash.cc} at campus ${input.campus_id}.`,
    );
  }

  const campus = await prisma.campuses.findUnique({ where: { id: input.campus_id } });
  if (!campus) throw new Error(`Campus id ${input.campus_id} not found (CC ${input.cc})`);

  const cls = await prisma.classes.findFirst({ where: { class_code: input.classCode } });
  if (!cls) throw new Error(`Class code ${input.classCode} not found (CC ${input.cc})`);

  let sectionId: number | null = null;
  if (input.section) {
    const section = await prisma.sections.findFirst({
      where: { description: input.section },
    });
    if (!section) throw new Error(`Section ${input.section} not found (CC ${input.cc})`);
    sectionId = section.id;
  }

  return { classId: cls.id, sectionId };
}

async function enrollOne(
  input: Input,
  classId: number,
  sectionId: number | null,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const created = await tx.students.create({
      data: {
        cc: input.cc,
        full_name: input.full_name,
        gr_number: input.gr_number,
        status: 'ENROLLED',
        campus_id: input.campus_id,
        class_id: classId,
        section_id: sectionId,
        academic_year: ACADEMIC_YEAR,
        doa: DOA,
      },
    });

    await tx.student_progression_periods.create({
      data: {
        student_cc: created.cc,
        campus_id: created.campus_id,
        class_id: created.class_id,
        section_id: created.section_id,
        house_id: created.house_id,
        academic_year: created.academic_year,
        gr_number: created.gr_number,
        change_type: 'ENROLLED',
        changed_by: ACTOR,
        notes: 'Manually enrolled — returning historical student, no prior digital record in this system.',
        valid_from: new Date(),
        valid_to: null,
      },
    });

    await tx.student_flags.create({
      data: {
        student_id: created.cc,
        flag: `MANUAL_HISTORICAL_ENROLLMENT_${input.cc}`,
        reminder_date: new Date(),
        work_done: true,
        comment:
          'Manually enrolled by staff as a returning student pre-dating digital records (no LEFT/EXPELLED row existed to reinstate).',
      },
    });

    await tx.audit_logs.create({
      data: {
        entity_type: 'STUDENT',
        entity_id: String(created.cc),
        action: 'MANUAL_HISTORICAL_ENROLLMENT',
        section: 'student',
        new_value: 'ENROLLED',
        changed_by: ACTOR,
        student_id: created.cc,
        changed_at: new Date(),
        note: `${created.full_name} (CC ${created.cc}, GR ${created.gr_number}) manually enrolled as a returning historical student — no prior digital record existed for this CC.`,
      },
    });
  });
}

async function main() {
  const fileArg = process.argv[2];
  if (!fileArg || fileArg.startsWith('-')) {
    usageAndExit();
  }

  const dryRun = process.env.DRY_RUN !== 'false';
  const inputs = loadInputs(fileArg);

  if (inputs.length === 0) {
    throw new Error('No students found in the input file.');
  }

  const seenCc = new Set<number>();
  for (const input of inputs) {
    if (seenCc.has(input.cc)) {
      throw new Error(`Duplicate CC ${input.cc} in the input file.`);
    }
    seenCc.add(input.cc);
  }

  console.log(
    dryRun
      ? `═══ DRY RUN  (${inputs.length} student(s) from ${fileArg})  set DRY_RUN=false to write ═══`
      : `═══ WRITING  (${inputs.length} student(s) from ${fileArg}) ═══`,
  );
  console.log(`Academic year=${ACADEMIC_YEAR}  DOA=${DOA.toISOString().slice(0, 10)}  actor=${ACTOR}`);

  const resolved: Array<Input & { classId: number; sectionId: number | null }> = [];
  for (const input of inputs) {
    const { classId, sectionId } = await preflight(input);
    resolved.push({ ...input, classId, sectionId });
    console.log(
      `OK  CC ${input.cc}  ${input.full_name}  GR ${input.gr_number}  class ${input.classCode}  section ${input.section ?? '—'}  campus ${input.campus_id}`,
    );
  }

  if (dryRun) {
    console.log('Dry run complete. No rows written.');
    return;
  }

  for (const row of resolved) {
    await enrollOne(row, row.classId, row.sectionId);
    console.log(`Created CC ${row.cc} — ${row.full_name}`);
  }

  console.log(`Done. Enrolled ${resolved.length} historical student(s).`);
}

main()
  .catch((err) => {
    console.error('FAILED:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
