import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

async function main() {
  const auditDir = path.join(__dirname, '../data-audits');
  if (!fs.existsSync(auditDir)) {
    fs.mkdirSync(auditDir);
  }

  console.log('Starting refined data audits...');

  // Helper to find Father
  const getFatherName = (guardians: any[]) => {
    const father = guardians.find(g => g.relationship?.toLowerCase().includes('father'));
    return father?.guardians?.full_name || 'N/A';
  };

  // 1. Students with no heads on or after 2026-04-01
  const targetDate = new Date('2026-04-01');
  const studentsWithNoHeads = await prisma.students.findMany({
    where: {
      deleted_at: null,
      NOT: {
        student_fees: {
          some: {
            fee_date: {
              gte: targetDate
            }
          }
        }
      }
    },
    include: {
      student_guardians: {
        include: { guardians: true },
        where: { relationship: { contains: 'Father', mode: 'insensitive' } }
      },
      classes: true
    }
  });

  const headers1 = 'CC,Full Name,Father Name,GR Number,Class\n';
  const csv1 = studentsWithNoHeads.map(s => {
    const fatherName = getFatherName(s.student_guardians);
    return `${s.cc},"${s.full_name}","${fatherName}",${s.gr_number || 'N/A'},"${s.classes?.description || 'N/A'}"`;
  }).join('\n');

  fs.writeFileSync(path.join(auditDir, 'missing_fee_heads_from_2026_04.csv'), headers1 + csv1);
  console.log(`- Missing fee heads: ${studentsWithNoHeads.length} students exported.`);

  // 2. Students with missing genders
  const studentsMissingGender = await prisma.students.findMany({
    where: {
      deleted_at: null,
      OR: [
        { gender: null },
        { gender: '' }
      ]
    },
    include: {
      student_guardians: {
        include: { guardians: true },
        where: { relationship: { contains: 'Father', mode: 'insensitive' } }
      },
      classes: true
    }
  });

  const headers2 = 'CC,Full Name,Father Name,GR Number,Class\n';
  const csv2 = studentsMissingGender.map(s => {
    const fatherName = getFatherName(s.student_guardians);
    return `${s.cc},"${s.full_name}","${fatherName}",${s.gr_number || 'N/A'},"${s.classes?.description || 'N/A'}"`;
  }).join('\n');

  fs.writeFileSync(path.join(auditDir, 'missing_genders.csv'), headers2 + csv2);
  console.log(`- Missing genders: ${studentsMissingGender.length} students exported.`);

  // 3. Students with missing fathers (specifically relationship 'Father')
  const studentsMissingFather = await prisma.students.findMany({
    where: {
      deleted_at: null,
      NOT: {
        student_guardians: {
          some: {
            relationship: {
              contains: 'Father',
              mode: 'insensitive'
            }
          }
        }
      }
    },
    include: {
      classes: true
    }
  });

  const headers3 = 'CC,Full Name,GR Number,Class\n';
  const csv3 = studentsMissingFather.map(s => {
    return `${s.cc},"${s.full_name}",${s.gr_number || 'N/A'},"${s.classes?.description || 'N/A'}"`;
  }).join('\n');

  fs.writeFileSync(path.join(auditDir, 'missing_father_connections.csv'), headers3 + csv3);
  console.log(`- Missing father connections: ${studentsMissingFather.length} students exported.`);

  console.log('Refined audit complete. Files located in tafs-backend/data-audits/');
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
