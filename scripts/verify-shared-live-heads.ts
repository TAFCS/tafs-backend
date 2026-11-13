/**
 * TAFSD-511: a fee head is billed on one live voucher at a time, and deleting a
 * voucher never un-pays a head paid through another one. Runs the real service
 * code in real transactions.
 *
 * LOCAL THROWAWAY DATABASE ONLY. It creates and changes rows, and it refuses to
 * run unless VERIFY_DB_URL is on 127.0.0.1 and the server confirms the database
 * name is tafs_test. Set the database up the way verify-family-credit-flows.ts
 * says (never `prisma db push` from this repo: the .env here is production).
 *   VERIFY_DB_URL=... DATABASE_URL=... ts-node <repo>/scripts/verify-shared-live-heads.ts
 */
const path = require('node:path');
const BE = path.resolve(__dirname, '..');
const LOCAL = process.env.VERIFY_DB_URL ?? '';
if (!/^postgres(ql)?:\/\/[^/]*@?127\.0\.0\.1[:/]/.test(LOCAL)) {
    throw new Error('ABORT: VERIFY_DB_URL must be a database on 127.0.0.1');
}
if (process.env.DATABASE_URL !== LOCAL) throw new Error('ABORT: DATABASE_URL must equal VERIFY_DB_URL');

/* eslint-disable */
const { PrismaClient, Prisma } = require(`${BE}/node_modules/@prisma/client`);
const { VouchersService } = require(`${BE}/src/modules/vouchers/vouchers.service`);

const prisma = new PrismaClient({ log: [], datasources: { db: { url: LOCAL } } });

let pass = 0;
const fails: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
    if (ok) { pass++; console.log(`  ok   ${name}`); }
    else { fails.push(name); console.log(`  FAIL ${name}`, detail ?? ''); }
};
const refused = async (name: string, fn: () => Promise<unknown>, pattern: RegExp) => {
    try { await fn(); check(name, false, 'was not refused'); }
    catch (e: any) {
        const msg = String(e?.response?.message ?? e?.message ?? e);
        check(name, pattern.test(msg), msg.slice(0, 300));
    }
};
const num = (v: unknown) => Number(v ?? 0);

let seq = 0;
const models = Prisma.dmmf.datamodel.models;
const enums = Prisma.dmmf.datamodel.enums;
async function mk(model: string, data: Record<string, unknown>) {
    const def = models.find((m: any) => m.name === model);
    const row: Record<string, unknown> = { ...data };
    for (const f of def.fields) {
        if (f.name in row || !f.isRequired || f.hasDefaultValue || f.isUpdatedAt || f.kind === 'object' || f.isList) continue;
        seq++;
        if (f.kind === 'enum') row[f.name] = enums.find((e: any) => e.name === f.type).values[0].name;
        else if (f.type === 'String') row[f.name] = `t${seq}`;
        else if (f.type === 'Int') row[f.name] = seq;
        else if (f.type === 'Decimal' || f.type === 'Float') row[f.name] = 0;
        else if (f.type === 'Boolean') row[f.name] = false;
        else if (f.type === 'DateTime') row[f.name] = new Date('2026-01-01');
    }
    return prisma[model].create({ data: row });
}

const svc = new VouchersService(
    prisma,
    { upload: async (k: string) => `https://example.test/${k}`, getPublicUrl: (k: string) => `https://example.test/${k}` },
    { generateVoucherPdf: async () => Buffer.from('%PDF-1.4') },
    {},
    { log: async () => 1, logGroup: async () => 1 },
    { sendVoucherIssuedNotification: async () => undefined },
    { canSeeStudent: () => true, whereForVouchers: () => ({}), whereForStudents: () => ({}) },
);
(svc as any).canSeeVoucher = async () => true;

const ctx: any = {};
async function seedBase() {
    ctx.campus = await mk('campuses', { campus_name: 'Test', campus_code: 'TST' });
    ctx.cls = await mk('classes', { description: 'V' });
    ctx.bank = await mk('bank_accounts', { bank_name: 'UBL', is_default: true });
    ctx.tuition = await mk('fee_types', { description: 'TUITION FEE' });
    ctx.lab = await mk('fee_types', { description: 'LAB FEE' });
}
const student = (name: string) =>
    mk('students', { full_name: name, campus_id: ctx.campus.id, class_id: ctx.cls.id, status: 'ENROLLED', gr_number: `G${++seq}` });
const fee = (st: any, type: any, amount: number, feeDate: string) =>
    mk('student_fees', {
        student_id: st.cc, fee_type_id: type.id, amount, amount_before_discount: amount, amount_paid: 0, status: 'NOT_ISSUED',
        target_month: Number(feeDate.slice(5, 7)), academic_year: '2026-2027', fee_date: new Date(feeDate),
    });
const issue = (st: any, feeDate: string, feeIds: number[]) => svc.create({
    student_id: st.cc, campus_id: ctx.campus.id, class_id: ctx.cls.id, bank_account_id: ctx.bank.id,
    issue_date: '2026-10-27', due_date: '2030-01-10', validity_date: '2030-01-15', fee_date: feeDate,
    orderedFeeIds: feeIds, late_fee_charge: false, academic_year: '2026-2027', month: Number(feeDate.slice(5, 7)),
    send_notification: false,
} as any, Buffer.from('%PDF'), 'tester');
const vstatus = async (id: number) => (await prisma.vouchers.findUnique({ where: { id }, select: { status: true } }))?.status;
const sfRow = (id: number) => prisma.student_fees.findUnique({ where: { id } });
const headsOf = (vid: number) => prisma.voucher_heads.findMany({ where: { voucher_id: vid }, orderBy: { id: 'asc' } });
const payInFull = async (vid: number) => {
    const hs = await headsOf(vid);
    const dist: Record<number, number> = {};
    let total = 0;
    for (const h of hs) { dist[h.id] = num(h.balance); total += num(h.balance); }
    return svc.recordDeposit(vid, { amount: total, distributions: dist, payment_method: 'cash' } as any, 'tester');
};

async function alizaCase() {
    console.log('\n== CC 8144: a Nov voucher issued after a Dec voucher that already bills Nov');
    const s = await student('ALIZA');
    const nov1 = await fee(s, ctx.tuition, 90000, '2026-11-01');
    const nov2 = await fee(s, ctx.lab, 9975, '2026-11-01');
    const dec = await fee(s, ctx.tuition, 19995, '2026-12-01');
    const vDec = await issue(s, '2026-12-01', [nov1.id, nov2.id, dec.id]);
    check('the Dec voucher (Nov + Dec heads) is issued', (await vStatusIn(vDec.id, ['UNPAID', 'OVERDUE'])) && (await headsOf(vDec.id)).length === 3);

    const before = await prisma.vouchers.count({ where: { student_id: s.cc } });
    await refused('issuing the Nov voucher for the same Nov heads is refused, naming the Dec voucher',
        () => issue(s, '2026-11-01', [nov1.id, nov2.id]),
        new RegExp(`voucher #${vDec.id}.*fee date 2026-12-01.*TUITION FEE`));
    check('...and nothing was written', (await prisma.vouchers.count({ where: { student_id: s.cc } })) === before
        && (await vStatusIn(vDec.id, ['UNPAID', 'OVERDUE'])));

    // The way out the message gives: delete the Dec voucher, then issue Nov.
    await svc.remove(vDec.id, 'tester');
    const vNov = await issue(s, '2026-11-01', [nov1.id, nov2.id]);
    check('after deleting the Dec voucher, the Nov voucher issues', (await headsOf(vNov.id)).length === 2);
    await payInFull(vNov.id);
    check('...and paying it leaves no other voucher billing the Nov heads',
        (await vstatus(vNov.id)) === 'PAID'
        && (await prisma.voucher_heads.count({ where: { student_fee_id: { in: [nov1.id, nov2.id] }, vouchers: { status: { in: ['UNPAID', 'OVERDUE', 'EXPIRED', 'PARTIALLY_PAID'] } } } })) === 0);
}
const vStatusIn = async (id: number, s: string[]) => s.includes(String(await vstatus(id)));

async function normalSupersession() {
    console.log('\n== Normal order still supersedes (Rule A)');
    const s = await student('NORMAL');
    const oct = await fee(s, ctx.tuition, 5000, '2026-10-01');
    const nov = await fee(s, ctx.tuition, 5000, '2026-11-01');
    const v1 = await issue(s, '2026-10-01', [oct.id]);
    const v2 = await issue(s, '2026-11-01', [nov.id]);
    check('issuing Nov after Oct voids Oct and carries its head', (await vstatus(v1.id)) === 'VOID'
        && (await headsOf(v2.id)).some((h: any) => h.student_fee_id === oct.id));
    const v2b = await issue(s, '2026-11-01', [nov.id]);
    check('re-issuing the same fee date replaces it (not refused)', (await vstatus(v2.id)) === 'VOID' && !!v2b.id);
    await svc.remove(v2b.id, 'tester');
    check('deleting the replacement brings the previous one back', await vStatusIn(v2.id, ['UNPAID', 'OVERDUE']));
}

async function forceDeleteCase() {
    console.log('\n== Force-delete of a stale voucher leaves heads paid elsewhere alone');
    const s = await student('STALE');
    const nov = await fee(s, ctx.tuition, 90000, '2026-11-01');
    const dec = await fee(s, ctx.tuition, 19995, '2026-12-01');
    const vNov = await issue(s, '2026-11-01', [nov.id]);
    await payInFull(vNov.id);
    const dep = await prisma.deposits.findFirst({ where: { student_id: s.cc } });
    // The legacy state the fix now prevents: a later EXPIRED voucher on the same head.
    const stale = await mk('vouchers', {
        student_id: s.cc, campus_id: ctx.campus.id, class_id: ctx.cls.id, bank_account_id: ctx.bank.id,
        issue_date: new Date('2026-10-27'), due_date: new Date('2026-11-10'), validity_date: new Date('2026-11-15'),
        fee_date: new Date('2026-12-01'), late_fee_charge: false, status: 'EXPIRED', academic_year: '2026-2027',
        total_payable_before_due: 109995, total_payable_after_due: 109995,
    });
    for (const f of [nov, dec]) {
        await mk('voucher_heads', { voucher_id: stale.id, student_fee_id: f.id, net_amount: f.amount, balance: f.amount, amount_deposited: 0, discount_amount: 0 });
    }
    await prisma.student_fees.update({ where: { id: dec.id }, data: { status: 'ISSUED' } });

    await svc.forceRemove(stale.id, 'tester');
    const n = await sfRow(nov.id);
    const d = await sfRow(dec.id);
    check('the stale voucher is gone', (await prisma.vouchers.findUnique({ where: { id: stale.id } })) === null);
    check('the Nov head stays PAID with its 90,000', n.status === 'PAID' && num(n.amount_paid) === 90000, n);
    check('the Dec head goes back to Not Issued', d.status === 'NOT_ISSUED' && num(d.amount_paid) === 0, d);
    check('the Nov voucher and its deposit are untouched', (await vstatus(vNov.id)) === 'PAID'
        && (await prisma.deposit_allocations.count({ where: { deposit_id: dep.id } })) > 0);
}

async function splitCase() {
    console.log('\n== Split');
    const s = await student('SPLIT');
    const a = await fee(s, ctx.tuition, 10000, '2026-11-01');
    const b = await fee(s, ctx.lab, 2000, '2026-11-01');
    const v = await issue(s, '2026-11-01', [a.id, b.id]);
    const hs = await headsOf(v.id);
    const ha = hs.find((h: any) => h.student_fee_id === a.id);
    await svc.recordDeposit(v.id, { amount: 4000, distributions: { [ha.id]: 4000 }, payment_method: 'cash' } as any, 'tester');
    check('voucher is PARTIALLY_PAID', (await vstatus(v.id)) === 'PARTIALLY_PAID');

    // Legacy overlap: another live voucher also bills the lab head.
    const other = await mk('vouchers', {
        student_id: s.cc, campus_id: ctx.campus.id, class_id: ctx.cls.id, bank_account_id: ctx.bank.id,
        issue_date: new Date('2026-10-27'), due_date: new Date('2030-01-10'), validity_date: new Date('2030-01-15'),
        fee_date: new Date('2026-12-01'), late_fee_charge: false, status: 'UNPAID', academic_year: '2026-2027',
        total_payable_before_due: 2000, total_payable_after_due: 2000,
    });
    const oh = await mk('voucher_heads', { voucher_id: other.id, student_fee_id: b.id, net_amount: 2000, balance: 2000, amount_deposited: 0, discount_amount: 0 });
    const splitDto = { issue_date: '2026-11-13', due_date: '2030-01-10', validity_date: '2030-01-15', balance_disposition: 'ISSUE_ONLY' };
    await refused('splitting is refused while another live voucher bills a balance head',
        () => svc.splitPartiallyPaid(v.id, splitDto as any, 'tester'),
        new RegExp(`voucher #${other.id}`));
    check('...and the voucher is still PARTIALLY_PAID', (await vstatus(v.id)) === 'PARTIALLY_PAID');

    await prisma.voucher_heads.delete({ where: { id: oh.id } });
    await prisma.vouchers.delete({ where: { id: other.id } });
    const res: any = await svc.splitPartiallyPaid(v.id, splitDto as any, 'tester');
    check('without the overlap the split goes through (its own voucher is not a clash)', (await vstatus(v.id)) === 'VOID', res && Object.keys(res));
}

async function main() {
    const [{ db }] = await prisma.$queryRaw`SELECT current_database() AS db`;
    if (db !== 'tafs_test') throw new Error(`ABORT: connected to ${db}, not tafs_test`);
    await seedBase();
    for (const step of [alizaCase, normalSupersession, forceDeleteCase, splitCase]) {
        try { await step(); }
        catch (e: any) { fails.push(`${step.name} threw`); console.log(`  FAIL ${step.name} threw:`, e?.response?.message ?? e?.message ?? e); }
    }
    console.log(`\n${pass} passed, ${fails.length} failed`);
    if (fails.length) { fails.forEach((f) => console.log('  -', f)); process.exitCode = 1; }
}

main().finally(() => prisma.$disconnect());
