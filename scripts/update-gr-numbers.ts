import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const dryRun = process.env.DRY_RUN === 'true';
  console.log(dryRun ? '--- DRY RUN MODE ---' : '--- EXECUTION MODE ---');

  const students = await prisma.students.findMany({
    where: {
      deleted_at: null,
    },
  });

  console.log(`Found ${students.length} active students.`);

  let updatedCount = 0;
  let skipCount = 0;

  for (const student of students) {
    const { cc, campus_id, class_id, gr_number } = student;
    let newGrNumber = gr_number;

    let prefix = '';

    if (campus_id === 1) {
      if (class_id === 21 || class_id === 22) {
        prefix = 'A-';
      }
    } else if (campus_id === 2) {
      prefix = 'KF-A';
    } else if (campus_id === 3) {
      prefix = 'A-N';
    }

    if (prefix && (!gr_number || !gr_number.startsWith(prefix))) {
      newGrNumber = `${prefix}${gr_number || ''}`;
    }

    if (newGrNumber !== gr_number) {
      console.log(`[UPDATE] CC: ${cc} | Campus: ${campus_id} | Class: ${class_id} | GR: ${gr_number || 'NULL'} -> ${newGrNumber}`);
      
      if (!dryRun) {
        await prisma.students.update({
          where: { cc },
          data: { gr_number: newGrNumber },
        });
      }
      updatedCount++;
    } else {
      skipCount++;
    }
  }

  console.log(`\nSummary:`);
  console.log(`Total students processed: ${students.length}`);
  console.log(`Students to be/actually updated: ${updatedCount}`);
  console.log(`Students skipped (already correct or no rule applied): ${skipCount}`);
  
  if (dryRun) {
    console.log('\nRun with DRY_RUN=false to apply changes.');
  }
}

main()
  .catch((e) => {
    console.error('Error executing script:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
