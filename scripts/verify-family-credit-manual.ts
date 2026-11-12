/**
 * TAFSD-504: the Family Credit tile's manual entries (add, deduct, refund, move
 * to another family, undo), the list, search and export, through the real
 * FamilyCreditService in real transactions, including two staff racing for one
 * balance and two clicking Undo on the same entry.
 *
 * LOCAL THROWAWAY DATABASE ONLY, set up exactly as the header of
 * verify-family-credit-flows.ts says (a cluster on 127.0.0.1:54329, database
 * tafs_test, pushed from a folder with no .env). It refuses to run anywhere else.
 *   VERIFY_DB_URL=... DATABASE_URL=... ts-node <repo>/scripts/verify-family-credit-manual.ts
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
const { FamilyCreditService } = require(`${BE}/src/modules/family-credit/family-credit.service`);
const { ScopeService } = require(`${BE}/src/common/scope/scope.service`);

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
const scope = new ScopeService(prisma, {});
const svc = new FamilyCreditService(prisma, scope, { log: async (e: any) => { audit.push(e); return 1; } });

const admin = { role: 'SUPER_ADMIN', username: 'admin', sub: '1', scope: undefined };
const balanceOf = async (familyId: number) =>
    Number((await prisma.family_credit_ledger.aggregate({ where: { family_id: familyId }, _sum: { amount: true } }))._sum.amount ?? 0);

(async () => {
    const where = await prisma.$queryRawUnsafe(`select inet_server_port()::int port, current_database() db`);
    if (where[0].port !== 54329 || where[0].db !== 'tafs_test') throw new Error('ABORT: not connected to the local test database');
    console.log('connected to local test database, port', where[0].port);

    const c1 = await mk('campuses', { campus_name: 'North', campus_code: 'MN1' });
    const c2 = await mk('campuses', { campus_name: 'South', campus_code: 'MS2' });
    const cls = await mk('classes', { description: 'VI' });
    const famA = await mk('families', { household_name: 'Manual Alpha', legacy_pid: 'LEG-A1' });
    const famB = await mk('families', { household_name: 'Manual Beta' });
    const famGone = await mk('families', { household_name: 'Manual Gone' });
    const sA = await mk('students', { full_name: 'Alpha Kid', family_id: famA.id, campus_id: c1.id, class_id: cls.id, status: 'ENROLLED', gr_number: 'GRA-77' });
    await mk('students', { full_name: 'Beta Kid', family_id: famB.id, campus_id: c2.id, class_id: cls.id, status: 'ENROLLED', gr_number: 'GRB-88' });
    const southOnly = { role: 'ACCOUNTANT', username: 'south', sub: '2', scope: { campuses: [c2.id], segments: [], classes: [], sections: [], departments: [], staffCategories: [] } };

    console.log('\nadd / deduct / refund');
    await svc.addCredit(famA.id, 10000, 'Opening balance from the old system', admin);
    check('add credit: balance 10,000', (await balanceOf(famA.id)) === 10000);
    await refused('deduct more than the balance is refused', () => svc.deductCredit(famA.id, 15000, 'Too much', admin), /below zero/);
    await svc.deductCredit(famA.id, 2000, 'Entered twice by mistake', admin);
    check('deduct: balance 8,000', (await balanceOf(famA.id)) === 8000);
    await svc.refundCredit(famA.id, 3000, 'cash', 'Family asked for it back', admin);
    const refundRow = await prisma.family_credit_ledger.findFirst({ where: { family_id: famA.id, kind: 'REFUNDED' } });
    check('refund: balance 5,000, method kept', (await balanceOf(famA.id)) === 5000 && refundRow.method === 'cash', refundRow);
    await refused('a reason is required', () => svc.addCredit(famA.id, 10, ' ', admin), /reason/);
    await refused('zero is refused', () => svc.addCredit(famA.id, 0, 'Nothing', admin), /above zero/);
    check('every write left an audit entry', audit.filter((a) => a.entity_type === 'FAMILY_CREDIT').length === 3);

    console.log('\ntransfer');
    await refused('cannot move credit to the same family', () => svc.transferCredit(famA.id, famA.id, 100, 'Same family', admin), /different family/);
    await refused('cannot move more than the family holds', () => svc.transferCredit(famA.id, famB.id, 6000, 'Too much', admin), /below zero/);
    await svc.transferCredit(famA.id, famB.id, 4000, 'Siblings registered under two family numbers', admin);
    const out = await prisma.family_credit_ledger.findFirst({ where: { family_id: famA.id, kind: 'TRANSFER_OUT' } });
    const into = await prisma.family_credit_ledger.findFirst({ where: { family_id: famB.id, kind: 'TRANSFER_IN' } });
    check('transfer: A 1,000, B 4,000', (await balanceOf(famA.id)) === 1000 && (await balanceOf(famB.id)) === 4000);
    check('transfer rows are linked both ways', into.linked_entry_id === out.id && out.counterpart_family_id === famB.id && into.counterpart_family_id === famA.id);

    console.log('\ntwo staff deduct from one balance at once');
    const race = await Promise.allSettled([
        svc.deductCredit(famA.id, 800, 'Race one', admin),
        svc.deductCredit(famA.id, 800, 'Race two', admin),
    ]);
    check('exactly one of two 800 deductions from 1,000 succeeds', race.filter((r) => r.status === 'fulfilled').length === 1, race.map((r) => r.status));
    check('balance never went below zero (200)', (await balanceOf(famA.id)) === 200);

    console.log('\nundo');
    await svc.deductCredit(famB.id, 1000, 'B spent some', admin);
    await refused('undoing the transfer is refused once B has used part of it', () => svc.undoEntry(out.id, 'Wrong family', admin), /below zero/);
    const bDeduct = await prisma.family_credit_ledger.findFirst({ where: { family_id: famB.id, kind: 'MANUAL_DEBIT' } });
    await svc.undoEntry(bDeduct.id, 'Deducted in error', admin);
    check('undo a deduction: B back to 4,000', (await balanceOf(famB.id)) === 4000);
    await svc.undoEntry(into.id, 'Wrong family after all', admin);
    check('undo a transfer from the receiving side undoes both halves', (await balanceOf(famA.id)) === 4200 && (await balanceOf(famB.id)) === 0);
    await refused('undoing the other half again is refused', () => svc.undoEntry(out.id, 'Again', admin), /already been undone/);
    await refused('undoing an undo is refused', async () => {
        const u = await prisma.family_credit_ledger.findFirst({ where: { kind: 'ENTRY_REVERSED', family_id: famA.id } });
        return svc.undoEntry(u.id, 'Undo the undo', admin);
    }, /itself an undo/);

    const excess = await prisma.family_credit_ledger.create({ data: { family_id: famA.id, amount: 500, kind: 'EXCESS_DEPOSIT', deposit_id: 999999, student_id: sA.cc, notes: 'Deposit #999999 excess.' } });
    await refused('a deposit entry cannot be undone here', () => svc.undoEntry(excess.id, 'Try it', admin), /Reverse the deposit/);

    const add2 = await svc.addCredit(famA.id, 300, 'For the double-click test', admin);
    const undoRace = await Promise.allSettled([
        svc.undoEntry(add2.entry_id, 'Click one', admin),
        svc.undoEntry(add2.entry_id, 'Click two', admin),
    ]);
    check('two Undo clicks on one entry: exactly one wins', undoRace.filter((r) => r.status === 'fulfilled').length === 1, undoRace.map((r: any) => r.reason?.message ?? r.status));
    check('balance after the undo race is 4,700', (await balanceOf(famA.id)) === 4700, await balanceOf(famA.id));

    const detail = await svc.detail(famA.id, admin);
    check('detail balance equals the ledger sum', detail.balance === (await balanceOf(famA.id)));
    const outView = detail.entries.find((e: any) => e.id === out.id);
    check('detail marks the transfer undone and not undoable', outView.undone_by_entry_id != null && outView.can_undo === false, outView);
    check('detail names the other family', outView.counterpart_family_name === 'Manual Beta');
    check('deposit entries are never undoable from the tile', detail.entries.find((e: any) => e.id === excess.id).can_undo === false);

    console.log('\nlist, search, scope, export');
    const all = await svc.list({}, admin);
    check('list shows A (holding credit) but not B (back to zero)', all.items.some((r: any) => r.family_id === famA.id) && !all.items.some((r: any) => r.family_id === famB.id));
    const withZero = await svc.list({ include_zero: true }, admin);
    check('include_zero lists B too', withZero.items.some((r: any) => r.family_id === famB.id && r.balance === 0));
    for (const [label, q] of [['family number', String(famA.id)], ['family name', 'alpha'], ['legacy id', 'LEG-A1'], ['student C.C.', String(sA.cc)], ['student G.R.', 'GRA-77']]) {
        const r = await svc.list({ q }, admin);
        // A bare number is both a family number and a C.C., so it can find two
        // families; it must always find the one meant.
        const exact = !/^\d+$/.test(q);
        check(`search by ${label} finds A`, r.items.some((i: any) => i.family_id === famA.id) && (!exact || r.items.length === 1), r.items.map((i: any) => i.family_id));
    }
    const camp = await svc.list({ include_zero: true, campus_ids: [c2.id] }, admin);
    check('campus filter: South lists B only', camp.items.length === 1 && camp.items[0].family_id === famB.id);
    const campBoth = await svc.list({ include_zero: true, campus_ids: [c1.id, c2.id] }, admin);
    check('campus filter takes several campuses', campBoth.items.length === 2);

    const scoped = await svc.list({ include_zero: true }, southOnly);
    check('a South-only user sees only South families', scoped.items.every((r: any) => r.family_id === famB.id) && scoped.items.length === 1);
    await refused('a South-only user gets 404 on a North family', () => svc.detail(famA.id, southOnly), /not found/);
    await refused('a South-only user cannot add to a North family', () => svc.addCredit(famA.id, 100, 'Out of scope', southOnly), /not found/);
    await refused('a South-only user cannot move credit into a North family', () => svc.transferCredit(famB.id, famA.id, 1, 'Out of scope', southOnly), /not found/);
    await refused('a South-only user cannot ask for the North campus', () => svc.list({ campus_ids: [c1.id] }, southOnly), /scope/);

    check('search-simple: empty text returns nothing', (await svc.searchSimple('', admin)).length === 0);
    const ss = await svc.searchSimple('Manual', southOnly);
    check('search-simple is scoped', ss.length === 1 && ss[0].family_id === famB.id, ss.map((s: any) => s.family_id));

    await prisma.family_credit_ledger.create({ data: { family_id: famGone.id, amount: 750, kind: 'MANUAL_CREDIT', notes: 'Students all left' } });
    check('a family with no students left is listed for an unrestricted user', (await svc.list({}, admin)).items.some((r: any) => r.family_id === famGone.id));
    check('...and hidden from a scoped user', !(await svc.list({}, southOnly)).items.some((r: any) => r.family_id === famGone.id));

    const xlsx = await svc.exportExcel({ include_zero: true }, admin);
    check('export is an xlsx file', xlsx.slice(0, 2).toString() === 'PK' && xlsx.length > 1000);

    const total = await prisma.family_credit_ledger.count();
    const kinds = (await prisma.family_credit_ledger.findMany({ where: { family_id: { in: [famA.id, famB.id, famGone.id] } }, select: { kind: true } })).map((r: any) => r.kind);
    check('only known kinds were written', kinds.every((k: string) => ['MANUAL_CREDIT', 'MANUAL_DEBIT', 'REFUNDED', 'TRANSFER_OUT', 'TRANSFER_IN', 'ENTRY_REVERSED', 'EXCESS_DEPOSIT'].includes(k)), total);

    console.log(`\n${pass} passed, ${fails.length} failed`);
    fails.forEach((f) => console.log('  FAILED:', f));
    await prisma.$disconnect();
    process.exit(fails.length ? 1 : 0);
})().catch(async (e) => {
    console.error('STOPPED:', String(e?.stack ?? e).slice(0, 1800));
    console.log(`${pass} passed before stopping, ${fails.length} failed`);
    await prisma.$disconnect();
    process.exit(1);
});
