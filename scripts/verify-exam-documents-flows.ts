/**
 * TAFSD-510: exam schedules and documents end to end, through the real
 * ExamDocumentsService and real transactions: the dues gate, overrides, serials
 * (including two staff issuing at once), reprints, scope, and the guards on
 * editing / deleting a schedule documents were issued from.
 *
 * LOCAL THROWAWAY DATABASE ONLY. It wipes and seeds tables. It refuses to run
 * unless VERIFY_DB_URL is on 127.0.0.1 and the server says the database is
 * tafs_test. Set the database up as verify-family-credit-flows.ts describes
 * (schema pushed from a folder with no .env), then:
 *   VERIFY_DB_URL=postgresql://postgres@127.0.0.1:54329/tafs_test \
 *   DATABASE_URL=$VERIFY_DB_URL npx ts-node --transpile-only scripts/verify-exam-documents-flows.ts
 */
/* eslint-disable */
const LOCAL = process.env.VERIFY_DB_URL ?? '';
if (!/^postgres(ql)?:\/\/[^/]*@?127\.0\.0\.1[:/]/.test(LOCAL)) throw new Error('ABORT: VERIFY_DB_URL must be a database on 127.0.0.1');
if (process.env.DATABASE_URL !== LOCAL) throw new Error('ABORT: DATABASE_URL must equal VERIFY_DB_URL');

import { PrismaClient } from '@prisma/client';
import { ExamDocumentsService } from '../src/modules/exam-documents/exam-documents.service';
import { ScopeService } from '../src/common/scope/scope.service';

const prisma = new PrismaClient({ log: [], datasources: { db: { url: LOCAL } } });
const audits: any[] = [];
const auditLogs = { log: async (p: any) => { audits.push(p); return 1; } } as any;
const storage = { extractKeyFromUrl: (u: string) => u, getFile: async () => { throw new Error('no photos here'); } } as any;
const svc = new ExamDocumentsService(prisma as any, new ScopeService(prisma as any), auditLogs, storage);

const ADMIN = { role: 'SUPER_ADMIN', username: 'verify-admin', sub: 1 } as any;
const OTHER_CAMPUS = { role: 'PRINCIPAL', username: 'knf-principal', sub: 2, campusId: 2 } as any;

let pass = 0;
const fails: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
    if (ok) { pass++; console.log(`  ok   ${name}`); }
    else { fails.push(name); console.log(`  FAIL ${name}`, detail ?? ''); }
};
async function rejects(name: string, fn: () => Promise<unknown>, match: RegExp | number) {
    try {
        await fn();
        check(name, false, 'did not throw');
    } catch (e: any) {
        const text = `${e?.status ?? ''} ${JSON.stringify(e?.response ?? e?.message)}`;
        check(name, typeof match === 'number' ? e?.status === match : match.test(text), text);
    }
}

const D = (s: string) => new Date(`${s}T00:00:00Z`);

async function seed() {
    await prisma.$executeRawUnsafe(`TRUNCATE exam_documents, exam_schedule_fee_dates, exam_schedule_papers, exam_schedule_classes, exam_schedules,
        voucher_arrear_surcharges, vouchers, student_fees, student_admissions, student_guardians, guardians, students, sections, classes, campuses, bank_accounts RESTART IDENTITY CASCADE`);
    await prisma.campuses.createMany({ data: [
        { id: 1, campus_code: 'GEJ', campus_name: 'Gulistan-e-Johar Campus', address: 'C 61-65 block 13 Gulistan e Jauhar' },
        { id: 2, campus_code: 'KNF', campus_name: 'Kaneez Fatima Campus' },
    ] });
    await prisma.classes.createMany({ data: [
        { id: 9, description: 'SR-I', class_code: 'SRI', academic_system: 'Cambridge' },
        { id: 10, description: 'SR-II', class_code: 'SRII', academic_system: 'Cambridge' },
        { id: 18, description: 'IX', class_code: 'IX', academic_system: 'Secondary' },
    ] });
    await prisma.sections.createMany({ data: [{ id: 1, description: 'A' }, { id: 2, description: 'B' }] });
    await prisma.bank_accounts.create({ data: { id: 1, account_title: 'TAFS', account_number: '1', bank_name: 'Test' } });
    const st = (cc: number, name: string, class_id: number, extra: any = {}) =>
        ({ cc, full_name: name, status: 'ENROLLED' as any, campus_id: 1, class_id, section_id: 1, gr_number: String(4000 + cc), dob: D('2014-01-05'), gender: 'Male', ...extra });
    await prisma.students.createMany({ data: [
        st(101, 'AYESHA CLEARED', 9),
        st(102, 'BILAL OWES HEAD', 9),
        st(103, 'CHAND OWES SURCHARGE', 9),
        st(104, 'DANIA IX CLEARED', 18, { section_id: 2 }),
        st(105, 'EHSAN IX CLEARED', 18),
        st(106, 'FARAH LEFT', 9, { status: 'LEFT' }),
        st(107, 'GHAZI SR-II', 10),
        st(108, 'HIRA KNF', 9, { campus_id: 2 }),
        st(109, 'IQRA NOT BILLED', 9, { section_id: 2 }),
    ] });
    await prisma.student_admissions.create({ data: { student_id: 101, academic_system: 'Cambridge', requested_grade: 'SR-I', discipline: 'Pre-Medical' } });
    await prisma.guardians.create({ data: { id: 1, full_name: 'KAMRAN SALEEM' } });
    await prisma.student_guardians.create({ data: { student_id: 101, guardian_id: 1, relationship: 'Father' } });

    const fee = (student_id: number, fee_date: string, amount: number, paid: number, status: string, extra: any = {}) => ({
        student_id, academic_year: '2026-2027', target_month: Number(fee_date.slice(5, 7)), fee_date: D(fee_date),
        amount, amount_before_discount: amount, amount_paid: paid, status: status as any, ...extra,
    });
    await prisma.student_fees.createMany({ data: [
        // 101: everything through December settled: paid, discounted, waived; January unpaid (after the cutoff).
        fee(101, '2026-11-01', 10000, 10000, 'PAID'),
        fee(101, '2026-12-01', 10000, 10000, 'PAID'),
        fee(101, '2026-12-01', -2000, 0, 'DISCOUNT', { is_discount: true }),
        fee(101, '2026-10-01', 5000, 0, 'WAIVED', { waived_amount: 5000 }),
        fee(101, '2027-01-01', 10000, 0, 'NOT_ISSUED'),
        // 102: December never billed, still owed; November part-paid.
        fee(102, '2026-11-01', 10000, 4000, 'PARTIALLY_PAID'),
        fee(102, '2026-12-01', 10000, 0, 'NOT_ISSUED'),
        // 103: heads paid, a Rs 1000 surcharge unpaid on a live voucher.
        fee(103, '2026-12-01', 10000, 10000, 'PAID'),
        // 104/105: paid. 104 has an `amount` null head that falls back to amount_before_discount, paid.
        fee(104, '2026-12-01', 10000, 10000, 'PAID'),
        { ...fee(105, '2026-12-01', 0, 9000, 'PAID'), amount: null, amount_before_discount: 9000 },
        fee(107, '2026-12-01', 10000, 10000, 'PAID'),
        // 109: November paid; December never put on a voucher. Owes, but only on a head the school hasn't billed.
        fee(109, '2026-11-01', 10000, 10000, 'PAID'),
        fee(109, '2026-12-01', 10000, 0, 'NOT_ISSUED'),
    ] });
    const v = await prisma.vouchers.create({ data: {
        student_id: 103, campus_id: 1, class_id: 9, bank_account_id: 1, issue_date: D('2026-12-01'), due_date: D('2026-12-10'),
        late_fee_charge: false, status: 'PARTIALLY_PAID', fee_date: D('2026-12-01'),
    } as any });
    await prisma.voucher_arrear_surcharges.create({ data: { voucher_id: v.id, arrear_fee_date: D('2026-11-01'), arrear_month: 11, arrear_year: '2026-2027', amount: 1000, amount_paid: 0 } });
    // A VOID voucher's surcharge must not count.
    const vv = await prisma.vouchers.create({ data: {
        student_id: 101, campus_id: 1, class_id: 9, bank_account_id: 1, issue_date: D('2026-11-01'), due_date: D('2026-11-10'),
        late_fee_charge: false, status: 'VOID', fee_date: D('2026-11-01'),
    } as any });
    await prisma.voucher_arrear_surcharges.create({ data: { voucher_id: vv.id, arrear_fee_date: D('2026-10-01'), arrear_month: 10, arrear_year: '2026-2027', amount: 1000, amount_paid: 0 } });
}

const body = (over: any = {}) => ({
    campus_id: 1, academic_year: '2026-2027', title: 'FIRST SEMESTER ASSESSMENTS', segment_line: 'SENIOR CAMBRIDGE',
    reference_no: 'TAFSAL-0001', fee_date: '2026-12-01', issue_from: '2099-01-01',
    notes: ['  Bring this every day.  ', '', 'No bags.'], class_ids: [9, 18],
    papers: [
        { class_id: 9, paper_date: '2026-12-11', time_text: '8:00 – 11:30', subject: 'CHEMISTRY' },
        { class_id: 9, paper_date: '2026-12-12', time_text: '8:00 – 11:30', subject: 'GEOGRAPHY' },
        { class_id: 18, paper_date: '2026-12-11', time_text: '8:00 – 11:30', subject: 'PHYSICS PRACTICAL' },
    ],
    ...over,
});

async function main() {
    const [{ db }] = await prisma.$queryRawUnsafe<{ db: string }[]>('SELECT current_database() AS db');
    if (db !== 'tafs_test') throw new Error(`ABORT: connected to ${db}, not tafs_test`);
    await seed();

    console.log('Schedules');
    const s = await svc.createSchedule(body() as any, ADMIN);
    check('saved as DRAFT with the exact fee date', s.status === 'DRAFT' && s.fee_date === '2026-12-01' && s.fee_date_label === '1 Dec 2026', s);
    check('blank notes dropped, others trimmed', JSON.stringify(s.notes) === JSON.stringify(['Bring this every day.', 'No bags.']));
    check('classes carry their document type', s.classes.find((c) => c.id === 18)?.doc_type === 'ADMIT_CARD' && s.classes.find((c) => c.id === 9)?.doc_type === 'STATEMENT_OF_ENTRY');
    await rejects('a paper for a class not on the schedule is refused', () => svc.createSchedule(body({ class_ids: [9] }) as any, ADMIN), /does not cover/);
    await rejects('another campus\'s principal cannot open it', () => svc.getSchedule(s.id, OTHER_CAMPUS), 403);
    check('and does not see it listed', (await svc.listSchedules({}, OTHER_CAMPUS)).length === 0);

    console.log('Issuing is gated');
    await rejects('nothing is issued from a draft', () => svc.issue(s.id, { student_ids: [101] }, ADMIN), /Publish the schedule/);
    await svc.setStatus(s.id, 'PUBLISHED', ADMIN);
    await rejects('nothing is issued before the issue date', () => svc.issue(s.id, { student_ids: [101] }, ADMIN), /can be issued from/);
    await svc.updateSchedule(s.id, body({ issue_from: '2026-01-01' }) as any, ADMIN);

    console.log('Dues through the fee date');
    const dues = await svc.duesThrough([101, 102, 103, 104, 105, 109], '2026-12-01');
    check('101 cleared: paid, discount and waived rows skipped, January ignored, VOID surcharge ignored', !dues.has(101), dues.get(101));
    check('102 owes 6,000 + 10,000 (the unbilled December head counts), 10,000 of it never billed', dues.get(102)?.heads_outstanding === 16000 && dues.get(102)?.not_billed_outstanding === 10000 && dues.get(102)?.oldest_fee_date === '2026-11-01', dues.get(102));
    check('102 owed by month: Nov 6,000 billed, Dec 10,000 not billed', JSON.stringify(dues.get(102)?.months) === JSON.stringify([{ fee_date: '2026-11-01', billed: 6000, not_billed: 0 }, { fee_date: '2026-12-01', billed: 0, not_billed: 10000 }]), dues.get(102)?.months);
    check('109 owes only on a head never billed', dues.get(109)?.heads_outstanding === 10000 && dues.get(109)?.not_billed_outstanding === 10000);
    check('103 owes only the 1,000 surcharge', dues.get(103)?.heads_outstanding === 0 && dues.get(103)?.surcharge_outstanding === 1000, dues.get(103));
    check('105 with a null amount falls back to amount_before_discount and is cleared', !dues.has(105));

    const r1 = await svc.roster(s.id, {}, ADMIN);
    check('roster: 3 cleared, 2 blocked, 1 not billed, 0 issued', r1.counts.CLEARED === 3 && r1.counts.BLOCKED === 2 && r1.counts.NOT_BILLED === 1 && r1.counts.ISSUED === 0, r1.counts);
    const row102 = r1.rows.find((r: any) => r.cc === 102);
    check('102 is BLOCKED (part of it is billed) and its row splits billed 6,000 / not billed 10,000', row102?.state === 'BLOCKED' && row102?.billed_owed === 6000 && row102?.not_billed_owed === 10000, row102);
    check('109 is NOT_BILLED with its fee date the schedule\'s', r1.rows.find((r: any) => r.cc === 109)?.state === 'NOT_BILLED' && r1.rows.find((r: any) => r.cc === 109)?.fee_date === '2026-12-01' && r1.rows.find((r: any) => r.cc === 109)?.own_fee_date === null);
    check('roster not-billed total is 10,000', r1.not_billed_owed_total === 10000, r1.not_billed_owed_total);
    check('roster leaves out a LEFT student, another class and another campus', !r1.rows.some((r: any) => [106, 107, 108].includes(r.cc)));
    check('roster blocked total is 17,000', r1.blocked_owed_total === 17000, r1.blocked_owed_total);
    const r1f = await svc.roster(s.id, { states: ['BLOCKED'], class_ids: [9] } as any, ADMIN);
    check('class filter narrows the counts; the state filter narrows only the list', r1f.rows.length === 2 && r1f.counts.CLEARED === 1 && r1f.counts.BLOCKED === 2 && r1f.counts.NOT_BILLED === 1, r1f.counts);
    const rd = await svc.roster(s.id, { disciplines: ['Pre-Medical'] } as any, ADMIN);
    check('discipline filter (Student Directory names) finds 101 only', rd.rows.length === 1 && rd.rows[0].cc === 101, rd.rows.map((r: any) => r.cc));
    const rn = await svc.roster(s.id, { disciplines: ['none'] } as any, ADMIN);
    check("'No discipline' finds everyone else", rn.rows.length === 5 && !rn.rows.some((r: any) => r.cc === 101));
    const rm = await svc.roster(s.id, { missing: ['father'] } as any, ADMIN);
    check('missing father finds everyone but 101', rm.rows.length === 5 && !rm.rows.some((r: any) => r.cc === 101));
    const rp = await svc.roster(s.id, { has_photo: 'true' } as any, ADMIN);
    check('has photo finds nobody here', rp.rows.length === 0);
    const r1q = await svc.roster(s.id, { q: 'bilal' } as any, ADMIN);
    check('server-side search finds by name', r1q.rows.length === 1 && r1q.rows[0].cc === 102);

    console.log('Issue, refuse, override, reprint');
    const a = await svc.issue(s.id, { student_ids: [101] }, ADMIN);
    const docA = await prisma.exam_documents.findUnique({ where: { schedule_id_student_id: { schedule_id: s.id, student_id: 101 } } });
    check('101 issued serial 1 as a statement of entry, PDF returned', docA?.serial_no === 1 && docA?.doc_type === 'STATEMENT_OF_ENTRY' && a.buffer.subarray(0, 4).toString() === '%PDF');
    check('issue wrote an activity log entry for the student', audits.some((x) => x.entity_type === 'EXAM_DOCUMENT' && x.student_id === 101));
    await rejects('a batch with a blocked student is refused whole, listing them', () => svc.issue(s.id, { student_ids: [101, 102] }, ADMIN), /DUES_NOT_CLEARED.*C\.C\. 102\) Rs 16,000/s);
    const docA2 = await prisma.exam_documents.findUnique({ where: { id: docA!.id } });
    check('and the refused batch did not reprint 101', docA2?.print_count === 1);
    await rejects('a student who only owes unbilled fees is refused too, and told to generate the voucher', () => svc.issue(s.id, { student_ids: [109] }, ADMIN), /DUES_NOT_CLEARED.*not billed yet.*generate their vouchers first/s);
    await rejects('a LEFT student is refused', () => svc.issue(s.id, { student_ids: [106] }, ADMIN), /not enrolled/);
    await rejects('a class not on the schedule is refused', () => svc.issue(s.id, { student_ids: [107] }, ADMIN), /not on this schedule/);
    await rejects('another campus is refused', () => svc.issue(s.id, { student_ids: [108] }, ADMIN), /another campus/);

    await rejects('an override needs a real reason', () => svc.override(s.id, { student_id: 102, reason: 'ok   ' }, ADMIN), /reason/);
    await svc.override(s.id, { student_id: 102, reason: 'Cheque handed in on 8 Dec' }, ADMIN);
    const docB = await prisma.exam_documents.findUnique({ where: { schedule_id_student_id: { schedule_id: s.id, student_id: 102 } } });
    check('102 overridden: serial 2, owed snapshot 16,000, reason and who recorded', docB?.serial_no === 2 && Number(docB?.dues_outstanding) === 16000 && docB?.override_reason === 'Cheque handed in on 8 Dec' && docB?.overridden_by === 'verify-admin', docB);
    check('override logged with the reason', audits.some((x) => x.field === 'DUES_OVERRIDE' && x.student_id === 102 && x.note === 'Cheque handed in on 8 Dec'));
    await rejects('no override for a student who already holds one', () => svc.override(s.id, { student_id: 101, reason: 'again please' }, ADMIN), 409);
    await rejects('no override for a student with nothing owed', () => svc.override(s.id, { student_id: 104, reason: 'just because' }, ADMIN), /no dues outstanding/);

    const re = await svc.issue(s.id, { student_ids: [101, 102] }, ADMIN);
    const docA3 = await prisma.exam_documents.findUnique({ where: { id: docA!.id } });
    check('reprint keeps serial 1 and counts the print; an overridden holder reprints without re-checking dues', re.reprinted === 2 && re.issued === 0 && docA3?.serial_no === 1 && docA3?.print_count === 2);

    console.log('Two staff issuing at once');
    await Promise.all([svc.issue(s.id, { student_ids: [104] }, ADMIN), svc.issue(s.id, { student_ids: [105] }, ADMIN)]);
    const serials = (await prisma.exam_documents.findMany({ where: { schedule_id: s.id }, orderBy: { serial_no: 'asc' } })).map((d) => d.serial_no);
    check('serials stay unique and gapless: 1,2,3,4', JSON.stringify(serials) === '[1,2,3,4]', serials);
    const doc104 = await prisma.exam_documents.findUnique({ where: { schedule_id_student_id: { schedule_id: s.id, student_id: 104 } } });
    check('IX gets an admit card, with the section at issue', doc104?.doc_type === 'ADMIT_CARD' && doc104?.section_id === 2);

    console.log('Paying clears');
    await prisma.voucher_arrear_surcharges.updateMany({ where: { vouchers: { student_id: 103 } }, data: { amount_paid: 1000 } });
    const r2 = await svc.roster(s.id, {}, ADMIN);
    check('103 is cleared once the surcharge is paid', r2.rows.find((r: any) => r.cc === 103)?.state === 'CLEARED');
    check('roster now: 1 cleared, 0 blocked, 1 not billed, 4 issued', r2.counts.CLEARED === 1 && r2.counts.BLOCKED === 0 && r2.counts.NOT_BILLED === 1 && r2.counts.ISSUED === 4, r2.counts);

    console.log('Fee dates');
    const opts = await svc.feeDateOptions(s.id, ADMIN);
    const dec = opts.options.find((o: any) => o.fee_date === '2026-12-01');
    check('the picker lists December with its two unbilled heads (102, 109)', dec?.not_billed === 2 && opts.options[0].fee_date === '2027-01-01', opts.options);
    const pv = await svc.previewFeeDate(s.id, { student_ids: [109, 101], fee_date: '2026-11-01' } as any, ADMIN);
    check('preview at 1 Nov: 109 would be cleared, holder 101 skipped', pv.counts.CLEARED === 1 && pv.students === 1 && pv.skipped_issued === 1, pv);
    const set = await svc.setStudentFeeDates(s.id, { student_ids: [109, 101], fee_date: '2026-11-01', reason: 'December voucher not issued yet' } as any, ADMIN);
    check('setting 109 to 1 Nov saves 1 and skips the holder', set.updated === 1 && set.skipped_issued === 1, set);
    check('the change is in the activity log with the reason', audits.some((x) => x.field === 'student_fee_date' && x.student_id === 109 && x.new_value === '2026-11-01' && /not issued yet/.test(x.note)));
    const r4 = await svc.roster(s.id, {}, ADMIN);
    const row109 = r4.rows.find((r: any) => r.cc === 109);
    check('109 is now CLEARED against its own date', row109?.state === 'CLEARED' && row109?.fee_date === '2026-11-01' && row109?.own_fee_date?.reason === 'December voucher not issued yet', row109);
    check('own-date filter finds 109 only', (await svc.roster(s.id, { fee_date_kinds: ['OWN'] } as any, ADMIN)).rows.map((r: any) => r.cc).join() === '109');
    await svc.issue(s.id, { student_ids: [109] }, ADMIN);
    const doc109 = await prisma.exam_documents.findUnique({ where: { schedule_id_student_id: { schedule_id: s.id, student_id: 109 } } });
    check('109 issued, and the document records the 1 Nov fee date it was checked against', doc109?.serial_no === 5 && doc109?.fee_date?.toISOString().slice(0, 10) === '2026-11-01', doc109);
    check("a holder's roster row shows the date on the document", (await svc.roster(s.id, {}, ADMIN)).rows.find((r: any) => r.cc === 109)?.document?.fee_date === '2026-11-01');

    // 103's surcharge back to unpaid; the schedule's date moves; own dates reset.
    await prisma.voucher_arrear_surcharges.updateMany({ where: { vouchers: { student_id: 103 } }, data: { amount_paid: 0 } });
    await svc.setStudentFeeDates(s.id, { student_ids: [103], fee_date: '2027-01-01' } as any, ADMIN);
    check('103 at a later own date (1 Jan) is blocked by the December surcharge', (await svc.roster(s.id, {}, ADMIN)).rows.find((r: any) => r.cc === 103)?.state === 'BLOCKED');
    await svc.setStudentFeeDates(s.id, { student_ids: [103], fee_date: null } as any, ADMIN);
    check('putting 103 back on the schedule date removes its own date', !(await prisma.exam_schedule_fee_dates.findUnique({ where: { schedule_id_student_id: { schedule_id: s.id, student_id: 103 } } })));
    await svc.setStudentFeeDates(s.id, { student_ids: [103], fee_date: '2026-12-01' } as any, ADMIN);
    check('an own date equal to the schedule date is not stored', !(await prisma.exam_schedule_fee_dates.findUnique({ where: { schedule_id_student_id: { schedule_id: s.id, student_id: 103 } } })));
    const moved = await svc.setScheduleFeeDate(s.id, '2026-11-01', ADMIN);
    check('schedule fee date changed and logged', moved.fee_date === '2026-11-01' && audits.some((x) => x.field === 'fee_date' && x.old_value === '2026-12-01' && x.new_value === '2026-11-01'));
    check('at 1 Nov the December surcharge no longer blocks 103', (await svc.roster(s.id, {}, ADMIN)).rows.find((r: any) => r.cc === 103)?.state === 'CLEARED');
    await svc.setScheduleFeeDate(s.id, '2026-12-01', ADMIN);
    await prisma.voucher_arrear_surcharges.updateMany({ where: { vouchers: { student_id: 103 } }, data: { amount_paid: 1000 } });
    await rejects('another campus cannot change fee dates', () => svc.setStudentFeeDates(s.id, { student_ids: [103], fee_date: '2026-11-01' } as any, OTHER_CAMPUS), 403);
    await rejects('a LEFT student cannot be given a date', () => svc.setStudentFeeDates(s.id, { student_ids: [106], fee_date: '2026-11-01' } as any, ADMIN), /not enrolled/);

    console.log('Holders who move, and schedule guards');
    await prisma.students.update({ where: { cc: 104 }, data: { class_id: 10 } });
    const r3 = await svc.roster(s.id, {}, ADMIN);
    check('a holder who moved class still shows as issued', r3.rows.find((r: any) => r.cc === 104)?.state === 'ISSUED');
    const reMoved = await svc.issue(s.id, { student_ids: [104] }, ADMIN);
    check('and can still be reprinted', reMoved.reprinted === 1);
    await rejects('removing a class documents were issued for is refused', () => svc.updateSchedule(s.id, body({ class_ids: [9], papers: body().papers.filter((p: any) => p.class_id === 9), issue_from: '2026-01-01' }) as any, ADMIN), 409);
    await rejects('changing the campus after issuing is refused', () => svc.updateSchedule(s.id, body({ campus_id: 2, issue_from: '2026-01-01' }) as any, ADMIN), 409);
    await rejects('deleting a schedule documents were issued from is refused', () => svc.deleteSchedule(s.id, ADMIN), 409);
    const edited = await svc.updateSchedule(s.id, body({ issue_from: '2026-01-01', papers: [...body().papers, { class_id: 9, paper_date: '2026-12-14', time_text: '8:00 – 11:30', subject: 'MATHEMATICS' }] }) as any, ADMIN);
    check('papers can still be corrected after issuing', edited.papers.length === 4 && edited.documents_issued === 5);

    const empty = await svc.createSchedule(body({ papers: body().papers.filter((p: any) => p.class_id === 9) }) as any, ADMIN);
    await rejects('a class with no papers cannot be published', () => svc.setStatus(empty.id, 'PUBLISHED', ADMIN), /No papers yet for IX/);
    await svc.deleteSchedule(empty.id, ADMIN);
    check('an unused schedule can be deleted', !(await prisma.exam_schedules.findUnique({ where: { id: empty.id } })));

    console.log(`\n${pass} passed, ${fails.length} failed`);
    if (fails.length) process.exitCode = 1;
}

main()
    .catch((e) => { console.error(e); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
