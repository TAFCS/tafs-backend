import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const pendingRequests = await prisma.parent_change_requests.findMany({
    where: { status: 'PENDING' },
    orderBy: [{ created_at: 'asc' }],
    include: {
      guardians: {
        select: {
          id: true,
          full_name: true,
        },
      },
      families: {
        select: {
          id: true,
          household_name: true,
        },
      },
    },
  });

  console.log(`Found ${pendingRequests.length} pending requests.`);

  // Group by (guardian_id, family_id, type_of_change)
  // For student updates: type + student_cc
  // For guardian updates: guardian fields
  for (const r of pendingRequests) {
    const data = r.requested_data as Record<string, any>;
    const reqType = data?.request_type ?? 'GUARDIAN_UPDATE';
    const studentCc = data?.student_cc ?? null;
    const fields = reqType === 'STUDENT_UPDATE' 
      ? Object.keys(data?.changes || {}) 
      : Object.keys(data || {}).filter(k => k !== 'request_type' && k !== 'student_cc');

    console.log(
      `ID: ${r.id} | Guardian: ${r.guardian_id} (${r.guardians?.full_name}) | Family: ${r.family_id} | Type: ${reqType} | StudentCC: ${studentCc} | Fields: [${fields.join(', ')}] | Created: ${r.created_at.toISOString()}`
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

