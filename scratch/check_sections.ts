import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const sections = await prisma.sections.findMany();
  console.log('Sections:', JSON.stringify(sections, null, 2));
  
  const campusSections = await prisma.campus_sections.findMany({
    include: {
      campuses: { select: { campus_name: true } },
      classes: { select: { description: true, class_code: true } },
      sections: { select: { description: true } }
    }
  });
  console.log('Campus Sections:', JSON.stringify(campusSections, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
