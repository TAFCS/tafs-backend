import * as xlsx from 'xlsx';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function normalizeDiscipline(raw: string): string | null {
  const clean = raw.trim().toUpperCase();
  if (!clean || clean === '----' || clean === '-----') return null;
  if (clean.includes('ENG')) return 'Pre-Engineering';
  if (clean.includes('MED')) return 'Pre-Medical';
  if (clean.includes('COMM')) return 'Commerce';
  if (clean.includes('COMP')) return 'COMPUTER';
  if (clean.includes('BIO')) return 'BIOLOGY';
  return raw.trim();
}

async function updateDisciplines() {
  const filePath = '/Volumes/umr_drive/Documents/tafs-backend/student-directory-2026-09-11-3.xlsx';
  console.log(`Reading Excel file: ${filePath}`);

  const workbook = xlsx.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json<any>(sheet);

  console.log(`Total rows in Excel: ${rows.length}`);

  const targetStudents: { cc: number; gr: string; name: string; rawDisc: string; normDisc: string; class: string; section: string }[] = [];

  for (const row of rows) {
    const cc = Number(row['CC']);
    const gr = String(row['GR'] || '').trim();
    const name = String(row['Student Name'] || '').trim();
    const rawDisc = String(row['Discipline'] || '').trim();
    const cls = String(row['Class'] || '').trim();
    const sec = String(row['Section'] || '').trim();

    const normDisc = normalizeDiscipline(rawDisc);
    if (normDisc) {
      targetStudents.push({
        cc,
        gr,
        name,
        rawDisc,
        normDisc,
        class: cls,
        section: sec,
      });
    }
  }

  console.log(`Found ${targetStudents.length} students with valid discipline in Excel.`);

  // Fetch all students in batch
  const ccs = targetStudents.map((t) => t.cc);
  const existingStudents = await prisma.students.findMany({
    where: { cc: { in: ccs } },
    include: {
      student_admissions: {
        orderBy: { application_date: 'desc' },
      },
    },
  });

  const studentMap = new Map<number, typeof existingStudents[0]>();
  for (const s of existingStudents) {
    studentMap.set(s.cc, s);
  }

  let updatedCount = 0;
  let alreadySetCount = 0;
  let errorCount = 0;

  for (const target of targetStudents) {
    const student = studentMap.get(target.cc);
    if (!student) {
      console.error(`[NOT FOUND IN DB] CC: ${target.cc}, Name: ${target.name}`);
      errorCount++;
      continue;
    }

    const latestAdmission = student.student_admissions[0];
    if (!latestAdmission) {
      await prisma.student_admissions.create({
        data: {
          student_id: target.cc,
          academic_system: 'Cambridge',
          requested_grade: target.class || 'O-I',
          discipline: target.normDisc,
        },
      });
      console.log(`[CREATED ADM] CC: ${target.cc} (${student.full_name}) -> ${target.normDisc}`);
      updatedCount++;
    } else {
      if (latestAdmission.discipline === target.normDisc) {
        alreadySetCount++;
      } else {
        await prisma.student_admissions.update({
          where: { id: latestAdmission.id },
          data: { discipline: target.normDisc },
        });
        console.log(`[UPDATED] CC: ${target.cc} | Name: ${student.full_name} | Old: ${latestAdmission.discipline || 'null'} -> New: ${target.normDisc}`);
        updatedCount++;
      }
    }
  }

  console.log('\n==========================================');
  console.log(`Migration Complete for student-directory-2026-09-11-3.xlsx:`);
  console.log(`- Target students: ${targetStudents.length}`);
  console.log(`- Updated: ${updatedCount}`);
  console.log(`- Already set: ${alreadySetCount}`);
  console.log(`- Errors / Missing: ${errorCount}`);
  console.log('==========================================\n');

  await prisma.$disconnect();
}

updateDisciplines().catch((err) => {
  console.error('Fatal error:', err);
  prisma.$disconnect();
  process.exit(1);
});
