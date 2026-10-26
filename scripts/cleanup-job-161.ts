import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const isWrite = process.argv.includes('--write') || process.env.WRITE === '1';
  console.log(`\n=== CLEANUP BULK VOUCHER JOB #161 (${isWrite ? 'LIVE WRITE' : 'DRY RUN'}) ===\n`);

  const job161 = await prisma.bulk_voucher_jobs.findUnique({
    where: { id: 161 },
  });

  if (!job161) {
    console.error('Job #161 not found!');
    return;
  }

  console.log('Current Job #161 state:');
  console.log({
    id: job161.id,
    status: job161.status,
    total_count: job161.total_count,
    success_count: job161.success_count,
    skip_count: job161.skip_count,
    fail_count: job161.fail_count,
    created_at: job161.created_at,
    updated_at: job161.updated_at,
  });

  const job162 = await prisma.bulk_voucher_jobs.findUnique({
    where: { id: 162 },
  });

  if (job162) {
    console.log('\nSuccessor Job #162 state:');
    console.log({
      id: job162.id,
      status: job162.status,
      total_count: job162.total_count,
      success_count: job162.success_count,
      skip_count: job162.skip_count,
      fail_count: job162.fail_count,
      merged_pdf_url: job162.merged_pdf_url,
    });
  }

  const existingVouchers161 = await prisma.vouchers.count({
    where: { bulk_voucher_job_id: 161 },
  });
  console.log(`\nRemaining vouchers linked to #161: ${existingVouchers161} (expected: 0, deleted on 20 Oct)`);

  const cleanupNote =
    'Job #161 was killed at 14:36 on 20 Oct by the auto-deploy of 4699bd1 (122 of 155 done). ' +
    'Its 122 vouchers were deleted at 14:45, and all 155 students were cleanly re-issued under job #162.';

  const existingReport = Array.isArray(job161.report) ? (job161.report as any[]) : [];
  const updatedReport = [
    ...existingReport,
    {
      status: 'INTERRUPTED',
      reason: cleanupNote,
      reissued_under_job_id: 162,
      cleaned_up_at: new Date().toISOString(),
    },
  ];

  console.log('\nPlanned updates for Job #161:');
  console.log({
    status: 'DONE',
    phase: 'DONE',
    note: cleanupNote,
    reportEntries: updatedReport.length,
  });

  if (!isWrite) {
    console.log('\n[DRY RUN] No database writes were performed. Run with --write to apply.\n');
    return;
  }

  // Live write
  await prisma.bulk_voucher_jobs.update({
    where: { id: 161 },
    data: {
      status: 'DONE',
      phase: 'DONE',
      report: updatedReport as any,
    },
  });

  await prisma.audit_logs.create({
    data: {
      entity_type: 'BULK_VOUCHER',
      entity_id: '161',
      action: 'UPDATED',
      field: 'status',
      new_value: 'DONE',
      changed_by: 'system',
      note: cleanupNote,
    },
  });

  console.log('\n✅ Job #161 successfully finalized and marked DONE with cleanup note and audit log.\n');
}

main()
  .catch((e) => {
    console.error('Error during cleanup:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
