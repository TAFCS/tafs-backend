const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

let passed = 0;
let failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✅ PASS  ${label}${detail ? '  (' + detail + ')' : ''}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL  ${label}${detail ? '  (' + detail + ')' : ''}`);
    failed++;
  }
}

async function main() {
  console.log('\n=== POST-MIGRATION VERIFICATION: DB-01 A2 Class ID Ordering ===\n');

  // ── 1. Classes table ────────────────────────────────────────────────────────
  console.log('--- classes table ---');
  const classes = await p.$queryRaw`SELECT id, class_code, description FROM classes ORDER BY id`;

  const asRow = classes.find(c => c.class_code === 'AS');
  const a2Row = classes.find(c => c.class_code === 'A2');

  assert('AS is at id=20',   asRow?.id === 20,  `found id=${asRow?.id}`);
  assert('A2 is at id=21',   a2Row?.id === 21,  `found id=${a2Row?.id}`);
  assert('id=21 (old AS) gone', !classes.some(c => c.id === 21 && c.class_code === 'AS'), '');
  assert('id=22 (old A2) gone', !classes.some(c => c.id === 22), '');

  console.log('\n  Full class list:');
  classes.forEach(c => console.log(`    id=${c.id}  code=${c.class_code}  desc=${c.description}`));

  // ── 2. Students ─────────────────────────────────────────────────────────────
  console.log('\n--- students ---');
  const orphanStudents = await p.students.count({ where: { class_id: { in: [22] } } });
  const a2Students     = await p.students.count({ where: { class_id: 21 } });
  const asStudents     = await p.students.count({ where: { class_id: 20 } });

  assert('No students orphaned at old IDs (21,22)', orphanStudents === 0, `found ${orphanStudents}`);
  assert('A2 students landed at class_id=21',       a2Students === 21,    `found ${a2Students} (expected 21)`);
  console.log(`  ℹ️  AS students at class_id=20: ${asStudents}`);

  // ── 3. Vouchers ─────────────────────────────────────────────────────────────
  console.log('\n--- vouchers ---');
  const orphanVouchers = await p.vouchers.count({ where: { class_id: { in: [22] } } });
  const a2Vouchers     = await p.vouchers.count({ where: { class_id: 21 } });
  const asVouchers     = await p.vouchers.count({ where: { class_id: 20 } });

  assert('No vouchers orphaned at old IDs (21,22)', orphanVouchers === 0, `found ${orphanVouchers}`);
  assert('A2 vouchers landed at class_id=21',       a2Vouchers === 78,    `found ${a2Vouchers} (expected 78)`);
  console.log(`  ℹ️  AS vouchers at class_id=20: ${asVouchers}`);

  // ── 4. campus_classes ───────────────────────────────────────────────────────
  console.log('\n--- campus_classes ---');
  const ccOrphan = await p.campus_classes.count({ where: { class_id: { in: [22] } } });
  const ccA2     = await p.campus_classes.findMany({ where: { class_id: 21 } });
  const ccAS     = await p.campus_classes.findMany({ where: { class_id: 20 } });

  assert('No campus_classes orphaned at old IDs', ccOrphan === 0, `found ${ccOrphan}`);
  assert('A2 campus_class at id=21',              ccA2.length === 1, `found ${ccA2.length} rows`);
  console.log(`  ℹ️  campus_classes for AS (id=20): ${ccAS.length} rows`);

  // ── 5. campus_sections ──────────────────────────────────────────────────────
  console.log('\n--- campus_sections ---');
  const csOrphan = await p.campus_sections.count({ where: { class_id: { in: [22] } } });
  const csA2     = await p.campus_sections.count({ where: { class_id: 21 } });

  assert('No campus_sections orphaned at old IDs', csOrphan === 0, `found ${csOrphan}`);
  assert('A2 campus_sections at id=21',            csA2 === 2,     `found ${csA2} (expected 2)`);

  // ── 6. class_attendance_modes ───────────────────────────────────────────────
  console.log('\n--- class_attendance_modes ---');
  const camOrphan = await p.$queryRaw`SELECT count(*) FROM class_attendance_modes WHERE class_id IN (22)`;
  const camA2     = await p.$queryRaw`SELECT count(*) FROM class_attendance_modes WHERE class_id = 21`;

  assert('No class_attendance_modes orphaned', Number(camOrphan[0].count) === 0, `found ${camOrphan[0].count}`);
  assert('A2 class_attendance_mode at id=21', Number(camA2[0].count) === 1, `found ${camA2[0].count}`);

  // ── 7. users.allowed_class_ids ──────────────────────────────────────────────
  console.log('\n--- users.allowed_class_ids ---');
  const usersOldA2 = await p.$queryRaw`SELECT id, username FROM users WHERE 22 = ANY(allowed_class_ids)`;
  const usersNewA2 = await p.$queryRaw`SELECT id, username, allowed_class_ids FROM users WHERE 21 = ANY(allowed_class_ids)`;

  assert('No users still have old id=22 in allowed_class_ids', usersOldA2.length === 0, `found ${usersOldA2.length}`);
  assert('syed.komail.hassan has new id=21 in allowed_class_ids',
    usersNewA2.some(u => u.username === 'syed.komail.hassan'), '');
  console.log(`  ℹ️  Users with A2 (21) in allowed_class_ids:`, usersNewA2.map(u => u.username));

  // ── 8. bulk_voucher_jobs.class_ids ──────────────────────────────────────────
  console.log('\n--- bulk_voucher_jobs.class_ids ---');
  const bjOld = await p.$queryRaw`SELECT count(*) FROM bulk_voucher_jobs WHERE 22 = ANY(class_ids)`;
  const bjNew = await p.$queryRaw`SELECT count(*) FROM bulk_voucher_jobs WHERE 21 = ANY(class_ids)`;

  assert('No bulk_voucher_jobs still have old id=22', Number(bjOld[0].count) === 0, `found ${bjOld[0].count}`);
  assert('2 bulk_voucher_jobs have new id=21',        Number(bjNew[0].count) === 2, `found ${bjNew[0].count}`);

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log('  🎉 All checks passed — migration is clean.');
  } else {
    console.error('  ⚠️  Some checks failed — investigate before deploying code changes.');
    process.exitCode = 1;
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => p.$disconnect());
