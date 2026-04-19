import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

async function main() {
  const auditDir = path.join(__dirname, '../data-audits');
  if (!fs.existsSync(auditDir)) {
    fs.mkdirSync(auditDir);
  }

  const roles = [
    'SUPER_ADMIN',
    'CAMPUS_ADMIN',
    'PRINCIPAL',
    'FINANCE_CLERK',
    'RECEPTIONIST',
    'TEACHER',
    'STAFF_EDITOR'
  ];

  console.log('Fetching all permissions from DB...');
  const allPermissions = await prisma.permissions.findMany({
    orderBy: [
      { module: 'asc' },
      { key: 'asc' }
    ]
  });

  if (allPermissions.length === 0) {
    console.error('No permissions found in the database. Make sure you have seeded them.');
    process.exit(1);
  }

  // Header
  const csvHeaders = [
    'Module',
    'Permission Key',
    'Description',
    ...roles.map(r => `Role: ${r}`)
  ];

  const csvRows = [csvHeaders.join(',')];

  allPermissions.forEach(p => {
    const row = [
      `"${p.module}"`,
      `"${p.key}"`,
      `"${p.description}"`,
      ...roles.map(() => '') // Empty columns for client to fill
    ];
    csvRows.push(row.join(','));
  });

  const filePath = path.join(auditDir, 'permission_matrix_template.csv');
  fs.writeFileSync(filePath, csvRows.join('\n'));

  console.log(`Success! Permission matrix template generated at: ${filePath}`);
  console.log(`Total Permissions: ${allPermissions.length}`);
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
