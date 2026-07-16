/**
 * Migrate non-colliding unconfirmed_admissions into students as QUICK_ADMISSION.
 *
 * - Non-colliding (id not in students.cc): insert student with same CC, related
 *   guardians/admissions, then DELETE the unconfirmed row (student is SoT).
 * - Colliding (id already in students.cc): leave BOTH rows untouched; log for ops.
 *
 * Usage: npx ts-node scripts/migrate-unconfirmed-to-quick-admission.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type Meta = {
  address?: string;
  admin_notes?: string;
  created_by?: string;
  deposit_amount?: number;
};

function mapRelation(relation?: string): string {
  const rel = (relation || 'GUARDIAN').toUpperCase();
  if (rel === 'FATHER') return 'Father';
  if (rel === 'MOTHER') return 'Mother';
  return 'Guardian';
}

async function main() {
  const unconfirmed = await prisma.unconfirmed_admissions.findMany({
    orderBy: { id: 'asc' },
  });

  console.log(`Found ${unconfirmed.length} unconfirmed_admissions row(s).`);

  const collisions: Array<{ id: number; full_name: string; student_name: string | null }> = [];
  let migrated = 0;

  for (const row of unconfirmed) {
    const existing = await prisma.students.findUnique({
      where: { cc: row.id },
      select: { cc: true, full_name: true },
    });

    if (existing) {
      collisions.push({
        id: row.id,
        full_name: row.full_name,
        student_name: existing.full_name,
      });
      console.warn(
        `[COLLISION] CC ${row.id}: unconfirmed="${row.full_name}" vs student="${existing.full_name}" — left both untouched`,
      );
      continue;
    }

    const meta: Meta = {
      address: row.address ?? undefined,
      admin_notes: row.admin_notes ?? undefined,
      created_by: row.created_by ?? undefined,
      deposit_amount: Number(row.deposit_amount),
    };

    await prisma.$transaction(async (tx) => {
      await tx.students.create({
        data: {
          cc: row.id,
          full_name: row.full_name,
          dob: row.date_of_birth,
          gender: row.gender,
          campus_id: row.campus_id,
          photograph_url: row.photograph_url,
          status: 'QUICK_ADMISSION' as any,
          quick_admission_meta: meta as any,
        },
      });

      if (row.academic_system || row.requested_grade) {
        await tx.student_admissions.create({
          data: {
            student_id: row.id,
            academic_system: row.academic_system || 'Secondary',
            requested_grade: row.requested_grade || 'N/A',
          },
        });
      }

      const guardians = (Array.isArray(row.guardians) ? row.guardians : []) as Array<{
        name?: string;
        relation?: string;
        cnic?: string;
        photograph_url?: string;
      }>;

      for (let i = 0; i < guardians.length; i++) {
        const g = guardians[i];
        const cnic = g.cnic && g.cnic !== 'N/A' ? g.cnic : null;
        const fullName = g.name?.trim() || null;
        const payload = {
          cnic,
          full_name: fullName,
          mailing_address: row.address ?? null,
          house_appt_name: row.address ?? null,
          photo_url: g.photograph_url ?? null,
        };

        let guardian;
        if (cnic) {
          guardian = await tx.guardians.upsert({
            where: { cnic },
            create: payload,
            update: {
              full_name: fullName ?? undefined,
              mailing_address: row.address ?? undefined,
              photo_url: g.photograph_url ?? undefined,
            },
          });
        } else {
          guardian = await tx.guardians.create({ data: payload });
        }

        await tx.student_guardians.upsert({
          where: {
            student_id_guardian_id: {
              student_id: row.id,
              guardian_id: guardian.id,
            },
          },
          create: {
            student_id: row.id,
            guardian_id: guardian.id,
            relationship: mapRelation(g.relation),
            is_primary_contact: i === 0,
            is_emergency_contact: i === 0,
          },
          update: {
            relationship: mapRelation(g.relation),
          },
        });
      }

      // Remove migrated unconfirmed row so directory does not duplicate
      await tx.unconfirmed_admissions.delete({ where: { id: row.id } });
    });

    migrated += 1;
    console.log(`[MIGRATED] CC ${row.id} (${row.full_name}) → students QUICK_ADMISSION`);
  }

  console.log('\n── Summary ──');
  console.log(`Migrated: ${migrated}`);
  console.log(`Collisions (manual ops): ${collisions.length}`);
  if (collisions.length) {
    console.log(JSON.stringify(collisions, null, 2));
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
