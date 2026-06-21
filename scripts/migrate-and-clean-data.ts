import { PrismaClient, TeacherCategory } from '@prisma/client';

const prisma = new PrismaClient();

// Map raw job title to standardized title and TeacherCategory enum
export function getCleanTitleAndCategory(
  rawTitle: string | null,
  designation: string | null
): { cleanedTitle: string | null; category: TeacherCategory | null } {
  const title = rawTitle ? rawTitle.trim() : '';
  const des = designation ? designation.trim().toUpperCase() : '';

  // 1. Homeroom & Assistant Teachers
  if (/^HOME TEACHER$/i.test(title)) {
    return { cleanedTitle: 'Homeroom Teacher', category: 'HOMEROOM_PRE_PRIMARY' };
  }
  if (/^CO-\s*TEACHER$/i.test(title)) {
    return { cleanedTitle: 'Co-Teacher', category: 'HOMEROOM_PRE_PRIMARY' };
  }
  if (/^HELPER TEACHER$/i.test(title)) {
    return { cleanedTitle: 'Assistant Teacher', category: 'HOMEROOM_PRE_PRIMARY' };
  }

  // 2. Languages
  if (/^ENGLISH TEACHER$/i.test(title)) {
    return { cleanedTitle: 'English Teacher', category: 'LANGUAGES' };
  }
  if (/^URDU TEACHER$/i.test(title) || 
      /^URDU TEACHER JR\.I$/i.test(title) || 
      /^URDU SR\.II A,\s*C\s*&\s*SR\.\s*III$/i.test(title) ||
      /SENIOR'S URDU TEACHER/i.test(title)) {
    return { cleanedTitle: 'Urdu Teacher', category: 'LANGUAGES' };
  }
  if (/^SINDHI\s*&\s*URDU$/i.test(title)) {
    return { cleanedTitle: 'Urdu & Sindhi Teacher', category: 'LANGUAGES' };
  }
  if (/^ENG V-II X ISL VII,VIII$/i.test(title)) {
    return { cleanedTitle: 'English & Islamiat Teacher', category: 'LANGUAGES' };
  }

  // 3. Mathematics
  if (/^MATHS TEACHER$/i.test(title) || /^MATHS$/i.test(title)) {
    return { cleanedTitle: 'Mathematics Teacher', category: 'MATHEMATICS' };
  }

  // 4. Sciences
  if (/^PHYSICS$/i.test(title)) {
    return { cleanedTitle: 'Physics Teacher', category: 'SCIENCES' };
  }
  if (/^CHEMISTRY$/i.test(title)) {
    return { cleanedTitle: 'Chemistry Teacher', category: 'SCIENCES' };
  }
  if (/^BIO TEACHER$/i.test(title)) {
    return { cleanedTitle: 'Biology Teacher', category: 'SCIENCES' };
  }
  if (/^CHEM\s*\/\s*BIO TEACHER$/i.test(title)) {
    return { cleanedTitle: 'Chemistry & Biology Teacher', category: 'SCIENCES' };
  }
  if (/^SCIENCE TEACHER JR\.III$/i.test(title)) {
    return { cleanedTitle: 'Science Teacher', category: 'SCIENCES' };
  }
  if (/^SCIENCE,\s*S\.S\.T\s*P\.ST$/i.test(title)) {
    return { cleanedTitle: 'Science & Social Studies Teacher', category: 'SCIENCES' };
  }

  // 5. IT & Computers
  if (/^COMPUTER TEACHER$/i.test(title)) {
    return { cleanedTitle: 'Computer Science Teacher', category: 'IT_COMPUTERS' };
  }

  // 6. Humanities & Social Sciences
  if (/^HIS\s*&\s*GEO SR\.\s*I\s*ISLAMIYAT\s*SR\.\s*I,\s*II$/i.test(title)) {
    return { cleanedTitle: 'Humanities & Islamiat Teacher', category: 'HUMANITIES_SOCIAL_SCIENCES' };
  }
  if (/^HIS\s*\/\s*GEO SR\.\s*II\s*-\s*III$/i.test(title)) {
    return { cleanedTitle: 'History & Geography Teacher', category: 'HUMANITIES_SOCIAL_SCIENCES' };
  }

  // 7. Arts & Co-Curricular
  if (/^ART TEACHER/i.test(title)) {
    return { cleanedTitle: 'Art Teacher', category: 'ARTS_CO_CURRICULAR' };
  }
  if (/^MUSIC TEACHER$/i.test(title)) {
    return { cleanedTitle: 'Music Teacher', category: 'ARTS_CO_CURRICULAR' };
  }
  if (/^SCOUT LEADER$/i.test(title)) {
    return { cleanedTitle: 'Scout Leader', category: 'ARTS_CO_CURRICULAR' };
  }

  // 8. Sports & P.E.
  if (/^SPORTS TEACHER$/i.test(title)) {
    return { cleanedTitle: 'Sports Teacher', category: 'SPORTS_PHYSICAL_EDUCATION' };
  }
  if (/^TAEKONDOW$/i.test(title)) {
    return { cleanedTitle: 'Martial Arts Instructor', category: 'SPORTS_PHYSICAL_EDUCATION' };
  }
  if (/^GYMNASTIC$/i.test(title)) {
    return { cleanedTitle: 'Gymnastics Instructor', category: 'SPORTS_PHYSICAL_EDUCATION' };
  }

  // 9. Administrative & Support
  if (/^OFFICE ASSISTANT$/i.test(title)) {
    return { cleanedTitle: 'Office Assistant', category: 'ADMIN_SUPPORT' };
  }

  // 10. Default mapping based on designation for NULL/empty titles
  if (!title) {
    // Management Designations
    if (/C\.E\.O|MANAGING DIRECTOR|DIRECTRESS|PRINCIPAL|COORDINATOR|CO-ORDINATOR|HEADMISTRESS|ADMINISTRATOR|MANAGER|SUBJECT HEAD/i.test(des)) {
      let cleaned = 'Management';
      if (/C\.E\.O/i.test(des)) cleaned = 'Chief Executive Officer';
      else if (/MANAGING DIRECTOR/i.test(des)) cleaned = 'Managing Director';
      else if (/DIRECTRESS FINANCE/i.test(des)) cleaned = 'Directress Finance';
      else if (/DIRECTRESS/i.test(des)) cleaned = 'Directress';
      else if (/PRINCIPAL/i.test(des)) cleaned = 'Principal';
      else if (/HEADMISTRESS/i.test(des)) cleaned = 'Headmistress';
      else if (/ADMINISTRATOR/i.test(des)) cleaned = 'Administrator';
      else if (/MANAGER SPORTS/i.test(des)) cleaned = 'Sports Manager';
      else if (/MANAGER/i.test(des)) cleaned = 'Manager';
      else if (/COORDINATOR|CO-ORDINATOR/i.test(des)) cleaned = 'Coordinator';
      else if (/SUBJECT HEAD/i.test(des)) cleaned = 'Subject Head & Coordinator';
      return { cleanedTitle: cleaned, category: 'MANAGEMENT' };
    }

    // Admin & Support Designations
    if (/ASSISTANT|OPERATOR|DESIGNER|F\.D\.O|ASST/i.test(des)) {
      let cleaned = 'Administrative Assistant';
      if (/GRAPHIC DESIGNER/i.test(des)) cleaned = 'Graphic Designer';
      else if (/COMPUTER OPERATOR/i.test(des)) cleaned = 'Computer Operator';
      else if (/F\.D\.O/i.test(des)) cleaned = 'Front Desk Officer / Office Assistant';
      else if (/ACCOUNTS ASSISTANT/i.test(des)) cleaned = 'Accounts Assistant & Coordinator';
      else if (/ACADEMIC ASSISTANT/i.test(des)) cleaned = 'Academic Assistant';
      return { cleanedTitle: cleaned, category: 'ADMIN_SUPPORT' };
    }

    // Domestic Designations
    if (/RIDER|PEON|GUARD|CLEANER/i.test(des)) {
      let cleaned = 'Domestic Staff';
      if (/RIDER/i.test(des)) cleaned = 'Outdoor Rider';
      return { cleanedTitle: cleaned, category: 'DOMESTIC_STAFF' };
    }
  }

  // Fallback for any unmapped
  return { 
    cleanedTitle: rawTitle || null, 
    category: null 
  };
}

async function main() {
  console.log('Fetching all employee profiles...');
  const employees = await prisma.employee_profiles.findMany({
    select: {
      id: true,
      employee_code: true,
      full_name: true,
      job_title: true,
      designations: {
        select: {
          title: true
        }
      }
    }
  });

  console.log(`Processing ${employees.length} employees...`);
  let updatedCount = 0;

  for (const emp of employees) {
    const designationTitle = emp.designations?.title || null;
    const { cleanedTitle, category } = getCleanTitleAndCategory(emp.job_title, designationTitle);

    console.log(`[${emp.employee_code}] ${emp.full_name || 'No Name'}:`);
    console.log(`  Current Title: "${emp.job_title}"`);
    console.log(`  Designation:   "${designationTitle}"`);
    console.log(`  Cleaned Title: "${cleanedTitle}"`);
    console.log(`  Category:      "${category}"`);

    await prisma.employee_profiles.update({
      where: { id: emp.id },
      data: {
        job_title: cleanedTitle,
        teacher_category: category
      }
    });

    updatedCount++;
  }

  console.log(`\nMigration completed! Successfully updated ${updatedCount} profiles.`);
}

main()
  .catch((e) => {
    console.error('Data Migration failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
