/**
 * One-off backfill: replay student_academic_history + house audit_logs into
 * student_progression_periods.
 *
 * Usage:
 *   DRY_RUN=true npx ts-node scripts/backfill-progression-periods.ts
 *   npx ts-node scripts/backfill-progression-periods.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type Placement = {
  campusId: number | null;
  classId: number | null;
  sectionId: number | null;
  houseId: number | null;
  academicYear: string | null;
  grNumber: string | null;
};

type ReplayEvent = {
  at: Date;
  changeType: string;
  changedBy: string | null;
  notes: string | null;
  patch: Partial<Placement>;
};

function placementUnchanged(a: Placement, b: Placement): boolean {
  return (
    a.campusId === b.campusId &&
    a.classId === b.classId &&
    a.sectionId === b.sectionId &&
    a.houseId === b.houseId
  );
}

function resolveChangeType(
  prior: Placement | null,
  next: Placement,
  defaultType: string,
): string {
  if (!prior) return defaultType;
  const campusSame = prior.campusId === next.campusId;
  const classSame = prior.classId === next.classId;
  const sectionSame = prior.sectionId === next.sectionId;
  const houseSame = prior.houseId === next.houseId;
  if (campusSame && classSame && sectionSame && !houseSame) {
    return 'HOUSE_CHANGED';
  }
  return defaultType;
}

async function backfillStudent(
  studentCc: number,
  dryRun: boolean,
): Promise<{ periods: number; skipped: boolean }> {
  const existing = await prisma.student_progression_periods.count({
    where: { student_cc: studentCc },
  });
  if (existing > 0) {
    return { periods: 0, skipped: true };
  }

  const [academicRows, houseLogs, current] = await Promise.all([
    prisma.student_academic_history.findMany({
      where: { student_cc: studentCc },
      orderBy: { changed_at: 'asc' },
    }),
    prisma.audit_logs.findMany({
      where: {
        student_id: studentCc,
        entity_type: 'STUDENT',
        field: 'student.house_id',
      },
      orderBy: { changed_at: 'asc' },
    }),
    prisma.students.findUnique({
      where: { cc: studentCc },
      select: {
        campus_id: true,
        class_id: true,
        section_id: true,
        house_id: true,
        academic_year: true,
        gr_number: true,
      },
    }),
  ]);

  const events: ReplayEvent[] = [];

  for (const row of academicRows) {
    events.push({
      at: row.changed_at,
      changeType: row.change_type,
      changedBy: row.changed_by,
      notes: row.notes,
      patch: {
        campusId: row.campus_id,
        classId: row.class_id,
        sectionId: row.section_id,
        academicYear: row.academic_year,
        grNumber: row.gr_number,
      },
    });
  }

  for (const log of houseLogs) {
    const houseId =
      log.new_value !== null && log.new_value !== undefined && log.new_value !== ''
        ? Number(log.new_value)
        : null;
    events.push({
      at: log.changed_at,
      changeType: 'HOUSE_CHANGED',
      changedBy: log.changed_by,
      notes: log.note,
      patch: { houseId: Number.isFinite(houseId as number) ? houseId : null },
    });
  }

  events.sort((a, b) => a.at.getTime() - b.at.getTime());

  if (events.length === 0) {
    // No historical events — seed one open period from current placement if any
    if (!current) return { periods: 0, skipped: false };
    if (
      current.campus_id == null &&
      current.class_id == null &&
      current.section_id == null &&
      current.house_id == null
    ) {
      return { periods: 0, skipped: false };
    }

    if (!dryRun) {
      await prisma.student_progression_periods.create({
        data: {
          student_cc: studentCc,
          campus_id: current.campus_id,
          class_id: current.class_id,
          section_id: current.section_id,
          house_id: current.house_id,
          academic_year: current.academic_year,
          gr_number: current.gr_number,
          change_type: 'ENROLLED',
          changed_by: null,
          valid_from: new Date(),
          valid_to: null,
        },
      });
    }
    return { periods: 1, skipped: false };
  }

  let state: Placement = {
    campusId: null,
    classId: null,
    sectionId: null,
    houseId: null,
    academicYear: null,
    grNumber: null,
  };

  type PeriodDraft = Placement & {
    changeType: string;
    changedBy: string | null;
    notes: string | null;
    validFrom: Date;
    validTo: Date | null;
  };

  const periods: PeriodDraft[] = [];

  for (const event of events) {
    const next: Placement = {
      campusId: event.patch.campusId !== undefined ? event.patch.campusId : state.campusId,
      classId: event.patch.classId !== undefined ? event.patch.classId : state.classId,
      sectionId: event.patch.sectionId !== undefined ? event.patch.sectionId : state.sectionId,
      houseId: event.patch.houseId !== undefined ? event.patch.houseId : state.houseId,
      academicYear:
        event.patch.academicYear !== undefined ? event.patch.academicYear : state.academicYear,
      grNumber: event.patch.grNumber !== undefined ? event.patch.grNumber : state.grNumber,
    };

    if (placementUnchanged(state, next) && periods.length > 0) {
      // Still update non-placement metadata on the open draft if needed
      state = next;
      continue;
    }

    const changeType = resolveChangeType(
      periods.length > 0 ? state : null,
      next,
      event.changeType,
    );

    if (periods.length > 0) {
      periods[periods.length - 1].validTo = event.at;
    }

    periods.push({
      ...next,
      changeType,
      changedBy: event.changedBy,
      notes: event.notes,
      validFrom: event.at,
      validTo: null,
    });
    state = next;
  }

  // Align final open period with current student placement if it differs
  // (e.g. house changed without audit, or latest state drifted). Prefer history.
  if (current && periods.length > 0) {
    const last = periods[periods.length - 1];
    last.campusId = current.campus_id ?? last.campusId;
    last.classId = current.class_id ?? last.classId;
    last.sectionId = current.section_id ?? last.sectionId;
    last.houseId = current.house_id ?? last.houseId;
    last.academicYear = current.academic_year ?? last.academicYear;
    last.grNumber = current.gr_number ?? last.grNumber;
  }

  if (!dryRun && periods.length > 0) {
    // Single bulk insert — avoids interactive-tx timeout on students with many events
    await prisma.student_progression_periods.createMany({
      data: periods.map((p) => ({
        student_cc: studentCc,
        campus_id: p.campusId,
        class_id: p.classId,
        section_id: p.sectionId,
        house_id: p.houseId,
        academic_year: p.academicYear,
        gr_number: p.grNumber,
        change_type: p.changeType,
        changed_by: p.changedBy,
        notes: p.notes,
        valid_from: p.validFrom,
        valid_to: p.validTo,
      })),
    });
  }

  return { periods: periods.length, skipped: false };
}

async function main() {
  const dryRun = process.env.DRY_RUN === 'true';
  console.log(dryRun ? '--- DRY RUN MODE ---' : '--- EXECUTION MODE ---');

  const studentCcs = await prisma.students.findMany({
    where: { deleted_at: null },
    select: { cc: true },
    orderBy: { cc: 'asc' },
  });

  console.log(`Found ${studentCcs.length} active students.`);

  let totalPeriods = 0;
  let studentsWithPeriods = 0;
  let skipped = 0;

  for (const { cc } of studentCcs) {
    const result = await backfillStudent(cc, dryRun);
    if (result.skipped) {
      skipped++;
      continue;
    }
    if (result.periods > 0) {
      studentsWithPeriods++;
      totalPeriods += result.periods;
      if (studentsWithPeriods <= 20 || result.periods > 1) {
        console.log(`CC ${cc}: ${result.periods} period(s)`);
      }
    }
  }

  console.log('--- Summary ---');
  console.log(`Students with new periods: ${studentsWithPeriods}`);
  console.log(`Total periods written:     ${totalPeriods}`);
  console.log(`Skipped (already filled):  ${skipped}`);
  if (dryRun) console.log('No rows were written (dry run).');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
