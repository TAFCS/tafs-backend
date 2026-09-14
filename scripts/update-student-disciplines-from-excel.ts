import * as xlsx from 'xlsx';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function updateDisciplines() {
  const filePath = '/Volumes/umr_drive/Documents/tafs-backend/student-directory-2026-09-11-4 (2).xlsx';
  console.log(`Reading Excel file: ${filePath}`);

  const workbook = xlsx.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json<any>(sheet);

  console.log(`Total rows in Excel: ${rows.length}`);

  const targetStudents: { cc: number; gr: string; name: string; discipline: string; class: string; section: string }[] = [];

  for (const row of rows) {
    const cc = Number(row['CC']);
    const gr = String(row['GR'] || '').trim();
    const name = String(row['Student Name'] || '').trim();
    const rawDisc = String(row['Discipline'] || '').trim();
    const cls = String(row['Class'] || '').trim();
    const sec = String(row['Section'] || '').trim();

    // Only students with a valid discipline (not empty and not dashes)
    if (rawDisc && rawDisc !== '----' && rawDisc !== '-----') {
      targetStudents.push({
        cc,
        gr,
        name,
        discipline: rawDisc.toUpperCase(),
        class: cls,
        section: sec,
      });
    }
  }

  console.log(`Found ${targetStudents.length} students with discipline in Excel.`);

  let updatedCount = 0;
  let alreadySetCount = 0;
  let errorCount = 0;

  const results: any[] = [];

  for (const target of targetStudents) {
    try {
      const student = await prisma.students.findUnique({
        where: { cc: target.cc },
        include: {
          student_admissions: {
            orderBy: { application_date: 'desc' },
          },
        },
      });

      if (!student) {
        console.error(`[NOT FOUND] Student CC: ${target.cc}, Name: ${target.name}`);
        errorCount++;
        continue;
      }

      const latestAdmission = student.student_admissions[0];

      if (!latestAdmission) {
        // Create an admission record if none exists
        await prisma.student_admissions.create({
          data: {
            student_id: target.cc,
            academic_system: 'Secondary',
            requested_grade: target.class || 'IX',
            discipline: target.discipline,
          },
        });
        console.log(`[CREATED ADMISSION & SET DISC] CC: ${target.cc} (${student.full_name}) -> ${target.discipline}`);
        updatedCount++;
        results.push({ cc: target.cc, name: student.full_name, oldDisc: null, newDisc: target.discipline, status: 'CREATED_AND_UPDATED' });
      } else {
        const oldDisc = latestAdmission.discipline;
        if (oldDisc === target.discipline) {
          alreadySetCount++;
          results.push({ cc: target.cc, name: student.full_name, oldDisc, newDisc: target.discipline, status: 'ALREADY_SET' });
        } else {
          await prisma.student_admissions.update({
            where: { id: latestAdmission.id },
            data: { discipline: target.discipline },
          });
          console.log(`[UPDATED] CC: ${target.cc} | Name: ${student.full_name} | Old: ${oldDisc || 'null'} -> New: ${target.discipline}`);
          updatedCount++;
          results.push({ cc: target.cc, name: student.full_name, oldDisc, newDisc: target.discipline, status: 'UPDATED' });
        }
      }
    } catch (err) {
      console.error(`[ERROR] CC: ${target.cc}:`, err);
      errorCount++;
    }
  }

  console.log('\n==========================================');
  console.log(`Migration Complete:`);
  console.log(`- Total target students: ${targetStudents.length}`);
  console.log(`- Updated: ${updatedCount}`);
  console.log(`- Already matching: ${alreadySetCount}`);
  console.log(`- Errors / Missing: ${errorCount}`);
  console.log('==========================================\n');

  await prisma.$disconnect();
}

updateDisciplines().catch((err) => {
  console.error('Fatal error:', err);
  prisma.$disconnect();
  process.exit(1);
});
