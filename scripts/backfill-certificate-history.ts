import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🔄 Starting Certificate Generation History Backfill...');

  let createdLogs = 0;

  // 1. Backfill historical Leaving Certificates (SLC) for students with assigned slc_number
  const slcStudents = await prisma.students.findMany({
    where: {
      slc_number: { not: null },
    },
    select: {
      cc: true,
      full_name: true,
      slc_number: true,
      created_at: true,
    },
  });

  for (const student of slcStudents) {
    const existing = await prisma.audit_logs.findFirst({
      where: {
        student_id: student.cc,
        section: 'CERTIFICATES',
        action: { contains: 'Leaving Certificate' },
      },
    });

    if (!existing) {
      await prisma.audit_logs.create({
        data: {
          entity_type: 'CERTIFICATE',
          entity_id: String(student.cc),
          action: 'Leaving Certificate (SLC)',
          section: 'CERTIFICATES',
          old_value: `SLC #${student.slc_number}`,
          changed_by: 'SYSTEM (Historical Backfill)',
          student_id: student.cc,
          note: `Historical Leaving Certificate #${student.slc_number} for ${student.full_name}`,
          changed_at: student.created_at || new Date(),
        },
      });
      createdLogs++;
    }
  }

  // 2. Backfill historical Admission Orders for all registered/enrolled students
  const enrolledStudents = await prisma.students.findMany({
    select: {
      cc: true,
      full_name: true,
      gr_number: true,
      created_at: true,
      student_admissions: {
        orderBy: { application_date: 'asc' },
        take: 1,
        select: { application_date: true },
      },
    },
  });

  for (const student of enrolledStudents) {
    const existing = await prisma.audit_logs.findFirst({
      where: {
        student_id: student.cc,
        section: 'CERTIFICATES',
        action: 'Admission Order',
      },
    });

    if (!existing) {
      const admDate = student.student_admissions[0]?.application_date || student.created_at || new Date();
      await prisma.audit_logs.create({
        data: {
          entity_type: 'CERTIFICATE',
          entity_id: String(student.cc),
          action: 'Admission Order',
          section: 'CERTIFICATES',
          old_value: student.gr_number ? `GR ${student.gr_number}` : `CC #${student.cc}`,
          changed_by: 'SYSTEM (Historical Backfill)',
          student_id: student.cc,
          note: `Historical Admission Order for ${student.full_name}`,
          changed_at: admDate,
        },
      });
      createdLogs++;
    }
  }

  // 3. Backfill historical Transfer Orders from student_academic_history
  const transferRecords = await prisma.student_academic_history.findMany({
    where: {
      change_type: 'TRANSFER',
    },
    select: {
      id: true,
      student_cc: true,
      changed_by: true,
      changed_at: true,
    },
  });

  for (const th of transferRecords) {
    const existing = await prisma.audit_logs.findFirst({
      where: {
        student_id: th.student_cc,
        section: 'CERTIFICATES',
        action: 'Transfer Order',
        changed_at: th.changed_at || undefined,
      },
    });

    if (!existing) {
      const student = await prisma.students.findUnique({
        where: { cc: th.student_cc },
        select: { full_name: true, gr_number: true },
      });

      await prisma.audit_logs.create({
        data: {
          entity_type: 'CERTIFICATE',
          entity_id: String(th.student_cc),
          action: 'Transfer Order',
          section: 'CERTIFICATES',
          old_value: student?.gr_number ? `GR ${student.gr_number}` : `CC #${th.student_cc}`,
          changed_by: th.changed_by || 'SYSTEM (Historical Backfill)',
          student_id: th.student_cc,
          note: `Historical Transfer Order for ${student?.full_name || `CC #${th.student_cc}`}`,
          changed_at: th.changed_at || new Date(),
        },
      });
      createdLogs++;
    }
  }

  console.log(`✅ Backfill complete. Inserted ${createdLogs} historical certificate issuance log entries.`);
}

main()
  .catch((e) => {
    console.error('❌ Backfill failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
