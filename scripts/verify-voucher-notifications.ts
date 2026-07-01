/**
 * Manual test helper for voucher notifications (NOTIF-01/02/03).
 *
 * Usage:
 *   npx ts-node scripts/verify-voucher-notifications.ts due_3d
 *   STUDENT_CC=44 npx ts-node scripts/verify-voucher-notifications.ts all
 *
 * Scenarios:
 *   due_3d | due_2d | due_1d     — NOTIF-01 approaching due reminders
 *   issued                       — VOUCHER_ISSUED (on create)
 *   became_overdue                 — NOTIF-02 (also marks voucher OVERDUE)
 *   expiry_3d | expiry_2d | expiry_1d — NOTIF-03 approaching expiry
 *   all                            — run due_3d + became_overdue + expiry_3d
 *
 * Env:
 *   STUDENT_CC=44                  — default 44 (AAWAIZ ALI)
 *   DRY_RUN=1                      — skip FCM push (still writes feed rows)
 *   PARENT_ACCESS_TOKEN            — optional; verifies GET /voucher-notifications
 *   API_BASE_URL                   — default http://localhost:8080/api/v1
 */
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { PrismaClient } from '@prisma/client';
import {
  VoucherNotificationService,
  addPktDays,
  dateFromPktKey,
  pktDateKey,
} from '../src/modules/vouchers/voucher-notification.service';

function loadEnvFile(): void {
  const envPath = resolve(__dirname, '../.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    if (process.env[key] === undefined) {
      process.env[key] = trimmed.slice(idx + 1).trim();
    }
  }
}

loadEnvFile();

const prisma = new PrismaClient();
const STUDENT_CC = parseInt(process.env.STUDENT_CC || '44', 10);
const DRY_RUN = process.env.DRY_RUN === '1';
const API_BASE_URL = (process.env.API_BASE_URL || 'http://localhost:8080/api/v1').replace(/\/$/, '');
const scenario = (process.argv[2] || 'due_3d').toLowerCase();

const fcmMock = {
  sendToFamily: async (familyId: number, title: string, body: string, data: Record<string, string>) => {
    if (DRY_RUN) {
      console.log(`  [DRY_RUN FCM] family=${familyId} title="${title}" data=${JSON.stringify(data)}`);
      return;
    }
    console.log(`  [FCM] family=${familyId} title="${title}"`);
    console.log(`        body="${body.slice(0, 120)}${body.length > 120 ? '…' : ''}"`);
  },
};

async function ensureMigration() {
  try {
    await prisma.$queryRaw`SELECT 1 FROM voucher_notifications LIMIT 1`;
  } catch {
    console.error('\nERROR: voucher_notifications table missing. Run first:\n  npx prisma migrate deploy\n');
    process.exit(1);
  }
}

async function ensureTestVoucher(student: {
  cc: number;
  campus_id: number | null;
  class_id: number | null;
  section_id: number | null;
}) {
  let voucher = await prisma.vouchers.findFirst({
    where: { student_id: student.cc, status: { in: ['UNPAID', 'OVERDUE'] } },
    orderBy: { id: 'desc' },
  });

  if (!voucher) {
    const bank = await prisma.bank_accounts.findFirst({
      where: { is_active: true },
      orderBy: { is_default: 'desc' },
      select: { id: true },
    });
    if (!bank) throw new Error('No active bank account found');

    const todayKey = pktDateKey(new Date());
    voucher = await prisma.vouchers.create({
      data: {
        student_id: student.cc,
        campus_id: student.campus_id!,
        class_id: student.class_id!,
        section_id: student.section_id,
        bank_account_id: bank.id,
        issue_date: dateFromPktKey(todayKey),
        due_date: dateFromPktKey(addPktDays(todayKey, 7)),
        validity_date: dateFromPktKey(addPktDays(todayKey, 30)),
        status: 'UNPAID',
        late_fee_charge: true,
        month: new Date().getMonth() + 1,
        total_payable_before_due: 18575,
        total_payable_after_due: 19575,
      },
    });
    console.log(`Created test voucher #${voucher.id} for CC ${student.cc}`);
  } else {
    console.log(`Using existing voucher #${voucher.id} (status=${voucher.status})`);
  }

  return voucher;
}

async function setVoucherDates(
  voucherId: number,
  opts: { dueKey?: string; validityKey?: string; status?: string },
) {
  return prisma.vouchers.update({
    where: { id: voucherId },
    data: {
      ...(opts.dueKey ? { due_date: dateFromPktKey(opts.dueKey) } : {}),
      ...(opts.validityKey ? { validity_date: dateFromPktKey(opts.validityKey) } : {}),
      ...(opts.status ? { status: opts.status } : {}),
    },
  });
}

async function printNotifications() {
  const rows = await prisma.voucher_notifications.findMany({
    where: { student_cc: STUDENT_CC },
    orderBy: { created_at: 'desc' },
    take: 10,
  });
  console.log('\nRecent voucher_notifications for CC', STUDENT_CC);
  if (rows.length === 0) {
    console.log('  (none yet)');
    return;
  }
  for (const r of rows) {
    console.log(`  #${r.id} voucher=${r.voucher_id} type=${r.alert_type} read=${r.read_at ? 'yes' : 'no'}`);
    console.log(`    ${r.title}`);
    console.log(`    ${r.body}`);
  }
}

async function verifyParentApi(familyId: number) {
  const token = process.env.PARENT_ACCESS_TOKEN;
  if (!token) {
    console.log('\nSkip API check — set PARENT_ACCESS_TOKEN to verify GET /voucher-notifications');
    return;
  }
  const res = await fetch(`${API_BASE_URL}/voucher-notifications`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  console.log(`\nGET /voucher-notifications → ${res.status}`);
  const list = Array.isArray(body?.data) ? body.data : body?.data?.data ?? [];
  console.log(`  ${list.length} item(s) for family ${familyId}`);
}

async function runScenario(
  name: string,
  service: VoucherNotificationService,
  voucherId: number,
  todayKey: string,
  fn: () => Promise<unknown>,
) {
  console.log(`\n--- ${name} ---`);
  await fn();
  await printNotifications();
}

async function main() {
  console.log(`\nVoucher notification test — CC ${STUDENT_CC}, scenario=${scenario}${DRY_RUN ? ' (DRY_RUN)' : ''}\n`);

  await ensureMigration();

  const student = await prisma.students.findUnique({
    where: { cc: STUDENT_CC },
    select: {
      cc: true,
      full_name: true,
      family_id: true,
      campus_id: true,
      class_id: true,
      section_id: true,
      families: { select: { id: true, household_name: true, email: true } },
    },
  });

  if (!student) {
    console.error(`Student CC ${STUDENT_CC} not found`);
    process.exit(1);
  }
  if (!student.family_id) {
    console.error(`Student CC ${STUDENT_CC} has no linked family — notifications are skipped by design`);
    process.exit(1);
  }

  console.log(`Student: ${student.full_name} (CC ${student.cc})`);
  console.log(`Family:  ${student.families?.household_name} id=${student.family_id} email=${student.families?.email ?? 'n/a'}`);

  const voucher = await ensureTestVoucher(student);
  const todayKey = pktDateKey(new Date());
  const service = new VoucherNotificationService(prisma as any, fcmMock as any, { broadcastVoucherAlert: () => {} } as any);

  const scenarios = scenario === 'all'
    ? ['issued', 'due_3d', 'became_overdue', 'expiry_3d']
    : [scenario];

  for (const s of scenarios) {
    switch (s) {
      case 'issued':
        await setVoucherDates(voucher.id, {
          dueKey: addPktDays(todayKey, 7),
          validityKey: addPktDays(todayKey, 30),
          status: 'UNPAID',
        });
        await runScenario('VOUCHER_ISSUED', service, voucher.id, todayKey, () =>
          service.sendVoucherIssuedNotification(voucher.id),
        );
        break;
      case 'due_3d':
        await setVoucherDates(voucher.id, { dueKey: addPktDays(todayKey, 3), status: 'UNPAID' });
        await runScenario('NOTIF-01 (3 days before due)', service, voucher.id, todayKey, () =>
          service.sendApproachingDueReminders(dateFromPktKey(todayKey)),
        );
        break;
      case 'due_2d':
        await setVoucherDates(voucher.id, { dueKey: addPktDays(todayKey, 2), status: 'UNPAID' });
        await runScenario('NOTIF-01 (2 days before due)', service, voucher.id, todayKey, () =>
          service.sendApproachingDueReminders(dateFromPktKey(todayKey)),
        );
        break;
      case 'due_1d':
        await setVoucherDates(voucher.id, { dueKey: addPktDays(todayKey, 1), status: 'UNPAID' });
        await runScenario('NOTIF-01 (1 day before due)', service, voucher.id, todayKey, () =>
          service.sendApproachingDueReminders(dateFromPktKey(todayKey)),
        );
        break;
      case 'became_overdue': {
        const yesterday = addPktDays(todayKey, -1);
        await setVoucherDates(voucher.id, { dueKey: yesterday, status: 'UNPAID' });
        await prisma.vouchers.update({ where: { id: voucher.id }, data: { status: 'OVERDUE' } });
        await runScenario('NOTIF-02 (became overdue)', service, voucher.id, todayKey, () =>
          service.sendBecameOverdueForVoucherIds([voucher.id]),
        );
        break;
      }
      case 'expiry_3d':
        await setVoucherDates(voucher.id, {
          dueKey: addPktDays(todayKey, -5),
          validityKey: addPktDays(todayKey, 3),
          status: 'OVERDUE',
        });
        await runScenario('NOTIF-03 (3 days before expiry)', service, voucher.id, todayKey, () =>
          service.sendApproachingExpiryReminders(dateFromPktKey(todayKey)),
        );
        break;
      case 'expiry_2d':
        await setVoucherDates(voucher.id, {
          validityKey: addPktDays(todayKey, 2),
          status: 'OVERDUE',
        });
        await runScenario('NOTIF-03 (2 days before expiry)', service, voucher.id, todayKey, () =>
          service.sendApproachingExpiryReminders(dateFromPktKey(todayKey)),
        );
        break;
      case 'expiry_1d':
        await setVoucherDates(voucher.id, {
          validityKey: addPktDays(todayKey, 1),
          status: 'OVERDUE',
        });
        await runScenario('NOTIF-03 (1 day before expiry)', service, voucher.id, todayKey, () =>
          service.sendApproachingExpiryReminders(dateFromPktKey(todayKey)),
        );
        break;
      default:
        console.error(`Unknown scenario: ${s}`);
        console.error('Use: issued | due_3d | due_2d | due_1d | became_overdue | expiry_3d | expiry_2d | expiry_1d | all');
        process.exit(1);
    }
  }

  await verifyParentApi(student.family_id);

  console.log('\nFlutter check:');
  console.log(`  1. Log in as parent (${student.families?.email ?? 'family account'})`);
  console.log('  2. Select AAWAIZ ALI on Home');
  console.log('  3. Pull to refresh Home feed — voucher alert card should appear');
  console.log('  4. Tap card → opens Fee Ledger');
  console.log('\nDone.\n');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
