import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const employees = await prisma.employee_profiles.findMany({
    select: {
      id: true,
      employee_code: true,
      full_name: true,
      job_title: true,
      staff_types: {
        select: {
          name: true,
          code: true
        }
      }
    }
  });

  console.log(`Total employees: ${employees.length}`);
  
  const titleCounts: Record<string, number> = {};
  const teacherTitles: Record<string, number> = {};
  
  for (const emp of employees) {
    const title = emp.job_title || 'NULL';
    titleCounts[title] = (titleCounts[title] || 0) + 1;
    
    // Check if they are a teacher or if the title contains teaching-related keywords
    const isTeacher = 
      emp.staff_types?.code === 'teacher' || 
      /teacher|instructor|tutor|lecturer|music|sport|art|montessori|co-teacher/i.test(title);
      
    if (isTeacher) {
      teacherTitles[title] = (teacherTitles[title] || 0) + 1;
    }
  }

  console.log('\n--- ALL JOB TITLES AND COUNTS ---');
  console.log(JSON.stringify(titleCounts, null, 2));

  console.log('\n--- TEACHER-RELATED JOB TITLES AND COUNTS ---');
  console.log(JSON.stringify(teacherTitles, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
