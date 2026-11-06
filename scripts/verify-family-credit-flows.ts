/**
 * TAFSD-419/420/421: family credit and the voucher stamps, through the real
 * service code in real transactions, including two staff racing for one balance.
 *
 * LOCAL THROWAWAY DATABASE ONLY. It creates and changes rows, and it refuses to
 * run unless VERIFY_DB_URL is on 127.0.0.1 and the server confirms the database
 * name is tafs_test. Never point it at the shared database.
 *
 * Never set up the database by running `prisma db push` from this repo: the .env
 * here is production (see the 2026-11-06 incident on TAFSD-421). Copy the schema
 * elsewhere with the URL written in, run the push from a folder with no .env, and
 * check the "Datasource" line says 127.0.0.1. Then, from that same folder:
 *   VERIFY_DB_URL=... DATABASE_URL=... ts-node <repo>/scripts/verify-family-credit-flows.ts
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
const { FinancialReportsService } = require(`${BE}/src/modules/financial-reports/financial-reports.service`);
const { StudentsService } = require(`${BE}/src/modules/students/students.service`);
const { hasOpenCreditEntries } = require(`${BE}/src/modules/vouchers/family-credit`);

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
        check(name, pattern.test(msg), msg.slice(0, 200));
    }
};
const num = (v: unknown) => Number(v ?? 0);

// Fills required columns so each row only names what the test cares about.
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

const audit: any[] = [];
const rendered: any[] = [];
const svc = new VouchersService(
    prisma,
    { upload: async (k: string) => `https://example.test/${k}`, getPublicUrl: (k: string) => `https://example.test/${k}` },
    { generateVoucherPdf: async (d: any) => { rendered.push(d); return Buffer.from('%PDF-1.4'); } },
    {},
    { log: async (e: any) => { audit.push(e); return 1; }, logGroup: async (e: any, c: any[]) => { audit.push(e, ...c); return 1; } },
    { sendVoucherIssuedNotification: async () => undefined },
    { canSeeStudent: () => true, whereForVouchers: () => ({}), whereForStudents: () => ({}) },
);
const reports = new FinancialReportsService(
    prisma,
    { log: async () => 1 },
    new Proxy({}, { get: () => () => ({}) }),
);

const ctx: any = {};
async function seedBase() {
    ctx.campus = await mk('campuses', { campus_name: 'Test', campus_code: 'TST' });
    ctx.cls = await mk('classes', { description: 'V' });
    ctx.bank = await mk('bank_accounts', { bank_name: 'UBL', is_default: true });
    ctx.feeType = await mk('fee_types', { description: 'TUITION' });
    await prisma.app_config.upsert({
        where: { key: 'pay_immediately_enabled' },
        create: { key: 'pay_immediately_enabled', value: 'true' },
        update: { value: 'true' },
    });
}
const student = (name: string, family: number | null) =>
    mk('students', { full_name: name, family_id: family, campus_id: ctx.campus.id, class_id: ctx.cls.id, status: 'ENROLLED', gr_number: `G${++seq}` });

let month = 1;
async function fee(st: any, amount: number, feeDate: string, status = 'ISSUED') {
    return mk('student_fees', {
        student_id: st.cc, fee_type_id: ctx.feeType.id, amount, amount_paid: 0, status,
        target_month: Number(feeDate.slice(5, 7)), academic_year: '2026-2027', fee_date: new Date(feeDate),
    });
}
async function voucher(st: any, amount: number, over: Record<string, unknown> = {}) {
    month++;
    const fd = `2026-${String(((month - 1) % 12) + 1).padStart(2, '0')}-05`;
    const f = await fee(st, amount, fd);
    const v = await mk('vouchers', {
        student_id: st.cc, campus_id: ctx.campus.id, class_id: ctx.cls.id, bank_account_id: ctx.bank.id,
        issue_date: new Date('2026-11-01'), due_date: new Date('2030-01-01'), validity_date: new Date('2030-01-01'),
        fee_date: new Date(fd), late_fee_charge: false, status: 'UNPAID', academic_year: '2026-2027',
        total_payable_before_due: amount, total_payable_after_due: amount, ...over,
    });
    const h = await mk('voucher_heads', {
        voucher_id: v.id, student_fee_id: f.id, net_amount: amount, balance: amount, amount_deposited: 0, discount_amount: 0,
    });
    return { v, h, f };
}
const balance = async (familyId: number) =>
    num((await prisma.family_credit_ledger.aggregate({ where: { family_id: familyId }, _sum: { amount: true } }))._sum.amount);
const status = async (id: number) => (await prisma.vouchers.findUnique({ where: { id }, select: { status: true } })).status;
const ledgerCount = (familyId: number) => prisma.family_credit_ledger.count({ where: { family_id: familyId } });

async function creditFlows() {
    console.log('\n== Family credit');
    const fam = await mk('families', { household_name: 'Fam A' });
    const a = await student('AAA', fam.id);
    const b = await student('BBB', fam.id);
    const noFam = await student('NOFAM', null);
    const va = await voucher(a, 45000);
    const vb = await voucher(b, 20000);
    const vb2 = await voucher(b, 30000);

    // Refusals leave nothing behind.
    const part = await voucher(a, 10000);
    await refused('an excess on a deposit that does not clear the voucher is refused',
        () => svc.recordDeposit(part.v.id, { amount: 6000, distributions: { [part.h.id]: 5000 }, excess_amount: 1000 } as any, 'tester'),
        /clears the whole voucher/);
    check('...and the refused deposit wrote nothing', (await prisma.deposits.count({ where: { student_id: a.cc } })) === 0
        && (await ledgerCount(fam.id)) === 0 && (await status(part.v.id)) === 'UNPAID');
    await refused('amounts that do not add up are refused',
        () => svc.recordDeposit(va.v.id, { amount: 80000, distributions: { [va.h.id]: 45000 } } as any, 'tester'),
        /must equal/);
    await refused('the family_credit method cannot be typed in by hand',
        () => svc.recordDeposit(va.v.id, { amount: 45000, distributions: { [va.h.id]: 45000 }, payment_method: 'family_credit' } as any, 'tester'),
        /Pay from credit/);
    const nf = await voucher(noFam, 1000);
    await refused('a student with no family cannot record an excess',
        () => svc.recordDeposit(nf.v.id, { amount: 1500, distributions: { [nf.h.id]: 1000 }, excess_amount: 500 } as any, 'tester'),
        /not linked to a family/);
    await refused('a student with no family cannot pay from credit',
        () => svc.recordDeposit(nf.v.id, { amount: 1000, distributions: { [nf.h.id]: 1000 }, pay_from_credit: true } as any, 'tester'),
        /not linked to a family/);

    // The ticket's own example.
    await svc.recordDeposit(va.v.id, { amount: 80000, distributions: { [va.h.id]: 45000 }, excess_amount: 35000, payment_method: 'cash' } as any, 'tester');
    const depA = await prisma.deposits.findFirst({ where: { student_id: a.cc }, orderBy: { id: 'desc' } });
    check('80,000 against 45,000 clears the voucher', (await status(va.v.id)) === 'PAID');
    check('the fee head got 45,000, not 80,000', num((await prisma.student_fees.findUnique({ where: { id: va.f.id } })).amount_paid) === 45000);
    check('the deposit records 80,000 of which 35,000 excess', num(depA.total_amount) === 80000 && num(depA.excess_amount) === 35000 && depA.from_credit === false);
    check('35,000 is now family credit', (await balance(fam.id)) === 35000);
    check('an audit entry was written for the ledger row', audit.some((e) => e.entity_type === 'FAMILY_CREDIT' && e.field === 'EXCESS_DEPOSIT'));

    const info = await svc.getFamilyCreditForVoucher(vb.v.id);
    check('a sibling\'s voucher sees the family balance', info.can_hold_credit === true && info.balance === 35000);
    check('a student with no family shows cannot hold credit', (await svc.getFamilyCreditForVoucher(nf.v.id)).can_hold_credit === false);

    // A sibling spends it.
    await svc.recordDeposit(vb.v.id, { amount: 20000, distributions: { [vb.h.id]: 20000 }, pay_from_credit: true } as any, 'tester');
    const depB = await prisma.deposits.findFirst({ where: { student_id: b.cc }, orderBy: { id: 'desc' } });
    check('a sibling\'s voucher can be paid from credit', (await status(vb.v.id)) === 'PAID');
    check('the credit payment is marked as no new cash', depB.from_credit === true && depB.payment_method === 'family_credit');
    check('the balance falls to 15,000', (await balance(fam.id)) === 15000);

    await refused('credit cannot be overdrawn',
        () => svc.recordDeposit(vb2.v.id, { amount: 20000, distributions: { [vb2.h.id]: 20000 }, pay_from_credit: true } as any, 'tester'),
        /does not cover/);
    check('...and nothing changed', (await balance(fam.id)) === 15000 && (await status(vb2.v.id)) === 'UNPAID');

    await refused('one deposit cannot be both an excess and a credit payment',
        () => svc.recordDeposit(vb2.v.id, { amount: 1000, distributions: { [vb2.h.id]: 500 }, pay_from_credit: true, excess_amount: 500 } as any, 'tester'),
        /cannot also have an excess/);

    // Reports: cash banked is 80,000, once.
    const today = new Date();
    const ymd = today.toISOString().slice(0, 10);
    const rep = await reports.listDeposits({ from_date: ymd, to_date: ymd, page: 1, limit: 50 } as any, { role: 'SUPER_ADMIN' } as any);
    check('Deposits report: cash banked excludes credit payments', rep.totals.total_amount === 80000, rep.totals);
    check('Deposits report: credit received 35,000, credit used 20,000', rep.totals.credit_received === 35000 && rep.totals.credit_used === 20000, rep.totals);
    check('Deposits report: reconciles (cash = allocations + excess)', rep.totals.reconciles === true, rep.totals);
    check('Deposits report: both deposits are still listed', rep.items.length === 2 && rep.pagination.total === 2, rep.pagination);
    const creditRow = rep.items.find((i: any) => i.paid_from_credit > 0);
    check('Deposits report: the credit row shows 0 cash', creditRow?.total_amount === 0 && creditRow?.paid_from_credit === 20000, creditRow);

    // The receipt must show what reached the bill, not the 80,000 handed over.
    rendered.length = 0;
    await svc.generatePdf(va.v.id, true, true, 'tester');
    const history = rendered[rendered.length - 1]?.paymentHistory ?? [];
    check('the receipt\'s payment history shows 45,000, not 80,000',
        history.some((r: any) => r.amount === '45,000') && !history.some((r: any) => r.amount === '80,000'), history);
    await prisma.vouchers.update({ where: { id: va.v.id }, data: { paid_pdf_url: null, paid_pdf_filename: null } });

    // Family credit has its own ledger, so it must not also show as Advance Credit.
    const studentsSvc = Object.create(StudentsService.prototype);
    studentsSvc.prisma = prisma;
    const digest = await studentsSvc.getFinancialDigest(a.cc);
    check('the excess does not also show as Advance Credit', num(digest.advance) === 0, digest.advance);
    const digestB = await studentsSvc.getFinancialDigest(b.cc);
    check('a credit payment does not show as Advance Credit', num(digestB.advance) === 0, digestB.advance);

    // Forced deletion and wipes must not strand credit.
    await refused('a voucher paid from credit cannot be force-deleted',
        () => svc.forceRemove(vb.v.id, 'tester'), /paid from family credit/);

    // Reversal order is enforced by the money.
    await refused('the excess cannot be reversed while a sibling has spent it',
        () => svc.reverseDeposit(depA.id, 'tester'), /Reverse those deposits first/);
    check('...and nothing changed', (await balance(fam.id)) === 15000 && (await status(va.v.id)) === 'PAID'
        && (await prisma.deposits.count({ where: { id: depA.id } })) === 1);

    await svc.reverseDeposit(depB.id, 'tester');
    check('reversing the credit payment returns the credit', (await balance(fam.id)) === 35000);
    check('...and the sibling\'s voucher owes again', (await status(vb.v.id)) !== 'PAID'
        && num((await prisma.student_fees.findUnique({ where: { id: vb.f.id } })).amount_paid) === 0);

    await svc.reverseDeposit(depA.id, 'tester');
    check('then the excess can be reversed, leaving 0', (await balance(fam.id)) === 0);
    check('...the original voucher owes again', (await status(va.v.id)) !== 'PAID');
    const rows = await prisma.family_credit_ledger.findMany({ where: { family_id: fam.id }, orderBy: { id: 'asc' } });
    check('the ledger is append-only: 4 rows, nothing deleted',
        rows.map((r: any) => r.kind).join() === 'EXCESS_DEPOSIT,APPLIED_TO_VOUCHER,APPLICATION_REVERSED,EXCESS_REVERSED', rows.map((r: any) => r.kind));

    // clearDeposit is the path the deposit screen uses.
    await svc.recordDeposit(vb2.v.id, { amount: 32000, distributions: { [vb2.h.id]: 30000 }, excess_amount: 2000 } as any, 'tester');
    const depC = await prisma.deposits.findFirst({ where: { student_id: b.cc }, orderBy: { id: 'desc' } });
    check('excess via a second family member', (await balance(fam.id)) === 2000);
    await svc.clearDeposit(vb2.v.id, depC.id, 'tester');
    check('clearDeposit takes the excess back out', (await balance(fam.id)) === 0);
    check('clearDeposit removed the deposit', (await prisma.deposits.count({ where: { id: depC.id } })) === 0);

    // Two staff racing for the same credit.
    const fam2 = await mk('families', { household_name: 'Race' });
    const c = await student('CCC', fam2.id);
    const d = await student('DDD', fam2.id);
    const e = await student('EEE', fam2.id);
    const src = await voucher(c, 1000);
    await svc.recordDeposit(src.v.id, { amount: 31000, distributions: { [src.h.id]: 1000 }, excess_amount: 30000 } as any, 'tester');
    const r1 = await voucher(d, 20000);
    const r2 = await voucher(e, 20000);
    const results = await Promise.allSettled([
        svc.recordDeposit(r1.v.id, { amount: 20000, distributions: { [r1.h.id]: 20000 }, pay_from_credit: true } as any, 'tester'),
        svc.recordDeposit(r2.v.id, { amount: 20000, distributions: { [r2.h.id]: 20000 }, pay_from_credit: true } as any, 'tester'),
    ]);
    check('two staff spending at once: exactly one succeeds', results.filter((x) => x.status === 'fulfilled').length === 1, results.map((x) => x.status));
    check('...and the balance never goes negative', (await balance(fam2.id)) === 10000, await balance(fam2.id));

    // Wipes refuse while entries stand.
    const open = await prisma.family_credit_ledger.findMany({ where: { student_id: c.cc }, select: { deposit_id: true, amount: true } });
    check('a student with standing credit entries is flagged for wipes', hasOpenCreditEntries(open) === true);
}

async function stampFlows() {
    console.log('\n== Stamps through the real create() and split');
    const fam = await mk('families', { household_name: 'Stamps' });
    const s = await student('STAMP', fam.id);
    const dates = ['2026-06-05', '2026-07-05', '2026-08-05', '2026-09-05', '2026-10-05'];
    const fees: any[] = [];
    for (const d of dates) fees.push(await fee(s, 1000, d, 'NOT_ISSUED'));
    const issue = (f: any, extra: Record<string, unknown> = {}) => svc.create({
        student_id: s.cc, campus_id: ctx.campus.id, class_id: ctx.cls.id, bank_account_id: ctx.bank.id,
        issue_date: '2026-11-02', due_date: '2026-11-20', validity_date: '2026-11-25', fee_date: f.fee_date.toISOString().slice(0, 10),
        orderedFeeIds: [f.id], late_fee_charge: false, academic_year: '2026-2027', month: f.target_month,
        send_notification: false, ...extra,
    } as any, Buffer.from('%PDF'), 'tester');
    const flags = async (id: number) => prisma.vouchers.findUnique({ where: { id }, select: { pay_immediately: true, pay_immediately_repeat: true, is_revised: true, status: true } });

    const v1 = await issue(fees[0]);
    let f1 = await flags(v1.id);
    check('1st unpaid voucher: no stamp', !f1.pay_immediately && !f1.pay_immediately_repeat && !f1.is_revised, f1);
    const v2 = await issue(fees[1]);
    const f2 = await flags(v2.id);
    check('2nd: still not PAY IMMEDIATELY', !f2.pay_immediately, f2);
    const v3 = await issue(fees[2]);
    const f3 = await flags(v3.id);
    check('3rd: PAY IMMEDIATELY, no warning yet', f3.pay_immediately && !f3.pay_immediately_repeat, f3);
    check('...and it voided the one before', (await status(v2.id)) === 'VOID');
    const v4 = await issue(fees[3], { is_revised: true });
    const f4 = await flags(v4.id);
    check('4th: PAY IMMEDIATELY with the warning (previous still unpaid)', f4.pay_immediately && f4.pay_immediately_repeat, f4);
    check('...read before supersession voided the previous one', (await status(v3.id)) === 'VOID');
    check('...and the REVISED toggle was saved', f4.is_revised === true, f4);
    const v5 = await issue(fees[4]);
    const f5 = await flags(v5.id);
    check('5th: the warning continues on every later one', f5.pay_immediately && f5.pay_immediately_repeat, f5);
    check('...REVISED does not carry over on its own', f5.is_revised === false, f5);

    const v5b = await issue(fees[4]);
    const f5b = await flags(v5b.id);
    check('re-issuing the same fee date keeps the level', f5b.pay_immediately && f5b.pay_immediately_repeat, f5b);

    // What the PDF is told.
    rendered.length = 0;
    await svc.generatePdf(v5b.id, true, false, 'tester', { force: true });
    const pdf = rendered[rendered.length - 1];
    check('the PDF gets PAY IMMEDIATELY + warning, no REVISED', pdf?.payImmediate === true && pdf?.payImmediateRepeat === true && pdf?.revised === false,
        { pi: pdf?.payImmediate, r: pdf?.payImmediateRepeat, rev: pdf?.revised });

    audit.length = 0;
    await svc.generatePdf(v5b.id, true, false, 'tester', { force: true, is_revised: true, changedBy: 'tester' });
    check('regenerate can turn REVISED on', (await flags(v5b.id)).is_revised === true);
    check('...the PDF now says REVISED', rendered[rendered.length - 1]?.revised === true);
    check('...with an audit entry', audit.some((e) => e.field === 'is_revised' && e.new_value === 'true'));
    await svc.generatePdf(v5b.id, true, false, 'tester', { force: false, is_revised: false } as any);
    check('without regenerate the flag cannot be changed', (await flags(v5b.id)).is_revised === true);
    await svc.generatePdf(v5b.id, true, false, 'tester', { force: true, is_revised: false, changedBy: 'tester' });
    check('regenerate can turn REVISED off', (await flags(v5b.id)).is_revised === false);

    // Split: partial pay, then split. PAY IMMEDIATELY balance is always REVISED.
    const heads = await prisma.voucher_heads.findMany({ where: { voucher_id: v5b.id } });
    const payable = heads.find((h: any) => num(h.balance) > 0);
    await svc.recordDeposit(v5b.id, { amount: 100, distributions: { [payable.id]: 100 } } as any, 'tester');
    const split = await svc.splitPartiallyPaid(v5b.id, {
        issue_date: '2026-11-03', due_date: '2026-11-20', validity_date: '2026-11-25', late_fee_charge: false, waived_by: 'tester', send_notification: false,
    } as any, 'tester');
    const unpaidId = split?.unpaid_voucher_id ?? split?.unpaidVoucher?.id;
    const paidId = split?.paid_voucher_id ?? split?.paidVoucher?.id;
    const bal = unpaidId ? await flags(unpaidId) : null;
    check('split balance: PAY IMMEDIATELY is REVISED without the toggle', !!bal && bal.pay_immediately && bal.is_revised, { bal, keys: Object.keys(split ?? {}) });
    check('split balance: keeps the warning level of the voucher split', !!bal && bal.pay_immediately_repeat, bal);
    const paid = paidId ? await flags(paidId) : null;
    check('split PAID receipt: carries neither', !!paid && !paid.pay_immediately && !paid.is_revised, paid);

    // A PAID receipt never says REVISED.
    const fam3 = await mk('families', { household_name: 'Paid' });
    const p = await student('PAID', fam3.id);
    const vp = await voucher(p, 500, { is_revised: true, pay_immediately: true, pay_immediately_repeat: true });
    await svc.recordDeposit(vp.v.id, { amount: 500, distributions: { [vp.h.id]: 500 } } as any, 'tester');
    rendered.length = 0;
    await svc.generatePdf(vp.v.id, true, true, 'tester');
    const receipt = rendered[rendered.length - 1];
    check('a PAID receipt prints no PAY IMMEDIATELY, warning or REVISED',
        receipt && !receipt.payImmediate && !receipt.payImmediateRepeat && !receipt.revised,
        { pi: receipt?.payImmediate, r: receipt?.payImmediateRepeat, rev: receipt?.revised });
}

(async () => {
    const where = await prisma.$queryRawUnsafe(`select inet_server_port()::int port, current_database() db`);
    if (where[0].port !== 54329 || where[0].db !== 'tafs_test') throw new Error('ABORT: not connected to the local test database');
    console.log('connected to local test database, port', where[0].port);
    await seedBase();
    await creditFlows();
    await stampFlows();
    console.log(`\n${pass} passed, ${fails.length} failed`);
    fails.forEach((f) => console.log('  FAILED:', f));
    await prisma.$disconnect();
    process.exit(fails.length ? 1 : 0);
})().catch(async (e) => {
    console.error('STOPPED:', String(e?.stack ?? e).slice(0, 1800));
    console.log(`${pass} passed before stopping, ${fails.length} failed`);
    await prisma.$disconnect();
    process.exit(2);
});
