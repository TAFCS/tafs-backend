import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const flag = await prisma.payroll_flags.findUnique({ where: { id: 314 } });
  console.log('FLAG 314:', JSON.stringify(flag, null, 2));

  const line = await prisma.payroll_run_lines.findUnique({
    where: { payroll_run_id_employee_id: { payroll_run_id: 47, employee_id: 163 } },
  });
  console.log('\nLINE (run 47, employee 163):', JSON.stringify(line, null, 2));

  const allFlagsForLine = await prisma.payroll_flags.findMany({
    where: { payroll_run_id: 47, employee_id: 163 },
  });
  console.log('\nALL FLAGS for this line:', JSON.stringify(allFlagsForLine, null, 2));

  const run = await prisma.payroll_runs.findUnique({ where: { id: 47 } });
  console.log('\nRUN 47:', JSON.stringify(run, null, 2));

  await prisma.$disconnect();
}
main();
