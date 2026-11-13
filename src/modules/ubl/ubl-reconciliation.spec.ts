import * as XLSX from 'xlsx';
import { UblReconciliationService } from './ubl-reconciliation.service';
import {
    SettlementLine,
    TafsTxn,
    dailyTotals,
    guessMapping,
    normalizeTxnId,
    parseAmount,
    parseSettlementDate,
    reconcile,
} from './ubl-reconciliation';

const txn = (over: Partial<TafsTxn> = {}): TafsTxn => ({
    transaction_id: 'T1',
    student_id: 44,
    student_name: 'TEST STUDENT AAWAIZ',
    campus: 'Kaneez Fatima Campus',
    consumer_number: '00044',
    voucher_number: '12260014422',
    channel: 'OTC',
    payment_method: 'CASH',
    amount_received: 15000,
    amount_booked: 15000,
    channel_fee: 0,
    // 2026-11-16 11:00 PKT
    transaction_at: new Date('2026-11-16T06:00:00Z'),
    deposit_id: 7001,
    deposit_exists: true,
    ...over,
});

let lineId = 0;
const line = (over: Partial<SettlementLine> = {}): SettlementLine => ({
    id: ++lineId,
    import_id: 1,
    transaction_id: 'T1',
    amount: 15000,
    transaction_date: '2026-11-16',
    settlement_date: '2026-11-17',
    channel: 'OTC',
    consumer_number: null,
    ...over,
});

describe('reconcile', () => {
    it('matches a payment UBL settled for exactly what TAFS booked', () => {
        const [row] = reconcile([txn()], [line()]);
        expect(row.status).toBe('MATCHED');
        expect(row.difference).toBe(0);
        expect(row.date).toBe('2026-11-16');
    });

    it('expects only the fee amount on a 1Bill payment, not the payer charge', () => {
        const onebill = txn({ channel: 'ONEBILL', amount_received: 25053, amount_booked: 25000, channel_fee: 53 });
        expect(reconcile([onebill], [line({ amount: 25000 })])[0].status).toBe('MATCHED');

        const gross = reconcile([onebill], [line({ amount: 25053 })])[0];
        expect(gross.status).toBe('AMOUNT_DIFFERS');
        expect(gross.difference).toBe(53);
        expect(gross.note).toMatch(/1Bill charge/);
    });

    it('flags a short settlement with the amount it is short by', () => {
        const [row] = reconcile([txn()], [line({ amount: 14000 })]);
        expect(row.status).toBe('AMOUNT_DIFFERS');
        expect(row.difference).toBe(-1000);
    });

    it('reports each side that is missing from the other', () => {
        const rows = reconcile([txn({ transaction_id: 'ONLY_TAFS' })], [line({ transaction_id: 'ONLY_UBL' })]);
        const by = Object.fromEntries(rows.map((r) => [r.transaction_id, r]));
        expect(by.ONLY_TAFS.status).toBe('NOT_SETTLED');
        expect(by.ONLY_TAFS.difference).toBe(-15000);
        expect(by.ONLY_UBL.status).toBe('NOT_AT_TAFS');
        expect(by.ONLY_UBL.expected).toBe(0);
        expect(by.ONLY_UBL.difference).toBe(15000);
        expect(by.ONLY_UBL.date).toBe('2026-11-16');
    });

    it('treats a reversed payment as owing nothing, and flags it if UBL settled it anyway', () => {
        const reversed = txn({ deposit_exists: false });
        expect(reconcile([reversed], [])[0].status).toBe('REVERSED_NOT_SETTLED');
        const settled = reconcile([reversed], [line()])[0];
        expect(settled.status).toBe('REVERSED_BUT_SETTLED');
        expect(settled.expected).toBe(0);
        expect(settled.difference).toBe(15000);
    });

    it('flags a transaction UBL settled more than once', () => {
        const [row] = reconcile([txn()], [line(), line({ import_id: 2 })]);
        expect(row.status).toBe('DUPLICATE_IN_SETTLEMENT');
        expect(row.ubl?.count).toBe(2);
        expect(row.ubl?.import_ids).toEqual([1, 2]);
        expect(row.difference).toBe(15000);
    });

    it('does not count the same settlement line twice when it is loaded twice', () => {
        const l = line();
        expect(reconcile([txn()], [l, l])[0].status).toBe('MATCHED');
    });
});

describe('dailyTotals', () => {
    it('dates each side on its own day and leaves reversed payments out', () => {
        const rows = dailyTotals(
            [txn(), txn({ transaction_id: 'T2', deposit_exists: false })],
            [line({ transaction_date: null, settlement_date: '2026-11-17', channel: 'Branch' })],
            '2026-11-16',
            '2026-11-17',
        );
        expect(rows).toEqual([
            { date: '2026-11-16', channel: 'OTC', tafs_count: 1, tafs_amount: 15000, ubl_count: 0, ubl_amount: 0, difference: -15000 },
            { date: '2026-11-17', channel: 'OTC', tafs_count: 0, tafs_amount: 0, ubl_count: 1, ubl_amount: 15000, difference: 15000 },
        ]);
    });

    it("files a UBL-only line under UBL's own channel name", () => {
        const rows = dailyTotals([], [line({ transaction_id: 'X', channel: 'branch' })], '2026-11-01', '2026-11-30');
        expect(rows[0].channel).toBe('BRANCH');
    });
});

describe('settlement file parsing', () => {
    it('reads amounts the way banks write them', () => {
        expect(parseAmount('15,000.00')).toBe(15000);
        expect(parseAmount('PKR 1,234.5')).toBe(1234.5);
        expect(parseAmount('Rs. 500')).toBe(500);
        expect(parseAmount('(100)')).toBe(-100);
        expect(parseAmount('100-')).toBe(-100);
        expect(parseAmount(2500)).toBe(2500);
        expect(parseAmount('')).toBeNull();
        expect(parseAmount('n/a')).toBeNull();
    });

    it('reads numeric dates day first', () => {
        expect(parseSettlementDate('12/10/2026')).toBe('2026-10-12');
        expect(parseSettlementDate('12-10-26')).toBe('2026-10-12');
        expect(parseSettlementDate('2026-10-12')).toBe('2026-10-12');
        expect(parseSettlementDate('20261012')).toBe('2026-10-12');
        expect(parseSettlementDate('12-Oct-2026 10:15:00')).toBe('2026-10-12');
        expect(parseSettlementDate('12 October 2026')).toBe('2026-10-12');
        expect(parseSettlementDate(46307)).toBe('2026-10-12'); // Excel serial
        expect(parseSettlementDate('31/02/2026')).toBeNull();
        expect(parseSettlementDate('soon')).toBeNull();
    });

    it("drops Excel's leading apostrophe from transaction ids", () => {
        expect(normalizeTxnId(" 'UBL20261005110000123 ")).toBe('UBL20261005110000123');
        expect(normalizeTxnId(123456)).toBe('123456');
    });

    it('guesses the columns of a typical statement', () => {
        expect(
            guessMapping(['Sr #', 'Transaction ID', 'Txn Date', 'Settlement Date', 'Consumer No', 'Channel', 'Amount (PKR)']),
        ).toEqual({
            transaction_id: 'Transaction ID',
            amount: 'Amount (PKR)',
            transaction_date: 'Txn Date',
            settlement_date: 'Settlement Date',
            channel: 'Channel',
            consumer_number: 'Consumer No',
        });
    });
});

describe('settlement CSV import', () => {
    const svc = new UblReconciliationService(
        {
            ubl_settlement_lines: { count: jest.fn().mockResolvedValue(0), createMany: jest.fn() },
            ubl_settlement_imports: { findFirst: jest.fn().mockResolvedValue(null) },
        } as any,
        { isExempt: () => true } as any,
        { log: jest.fn().mockResolvedValue(undefined) } as any,
    );
    const admin: any = { role: 'SUPER_ADMIN', username: 'x' };
    const file = (text: string): any => ({ originalname: 's.csv', buffer: Buffer.from(text), size: text.length });

    it('keeps CSV dates day first and long transaction ids exact', async () => {
        const csv = 'Txn,Date,Amount\nA1,12/10/2026,"1,000"\n123456789012345678901,05/11/2026,5\n';
        const p = await svc.previewSettlement(file(csv), admin);
        expect(p.sample_rows).toEqual([
            ['A1', '12/10/2026', '1,000'],
            ['123456789012345678901', '05/11/2026', '5'],
        ]);
        // Same parsing path as the import: a raw read keeps the text.
        const wb = XLSX.read(Buffer.from(csv), { type: 'buffer', raw: true });
        const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true });
        expect(parseSettlementDate(rows[1][1])).toBe('2026-10-12');
        expect(normalizeTxnId(rows[2][0])).toBe('123456789012345678901');
    });
});
