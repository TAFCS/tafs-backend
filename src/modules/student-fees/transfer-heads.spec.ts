// @react-pdf/renderer ships ESM that jest's CJS transform can't load, and it is
// pulled in transitively through the students service. Stub that boundary.
jest.mock('../voucher-pdf/voucher-pdf.service', () => ({
    VoucherPdfService: class { },
}));

import { StudentFeesService } from './student-fees.service';
import { resetClassTermMapCache } from '../../common/utils/class-terms.util';

/**
 * The fee-head year transfer.
 *
 * The rule under test: (target_month, academic_year) is ambiguous on its own —
 * "April of 2026-2027" is Apr 2026 under an Apr-Mar term but Apr 2027 under an
 * Aug-Jul one. A transfer therefore has to carry the destination term with it,
 * and the preview has to show the admin the label they will actually get.
 *
 * Fixture mirrors CC 7242 MARYAM ABBAS: heads billed on class 11 (Aug-Jul)
 * while the student now sits in class 18 (Apr-Mar).
 */
describe('StudentFeesService fee-head year transfer', () => {
    const CLASSES = [
        { id: 11, term_start_month: 8 },  // Aug-Jul: where the heads were billed
        { id: 18, term_start_month: 4 },  // Apr-Mar: where the student is now
    ];

    // April, May and June heads, PAID on class-11 vouchers.
    const head = (id: number, target_month: number) => ({
        id,
        student_id: 7242,
        fee_type_id: 1,
        target_month,
        academic_year: '2025-2026',
        term_start_month: null,
        amount: 18975,
        status: 'PAID',
        fee_types: { description: 'MONTHLY TUITION FEE' },
        students: { class_id: 18, full_name: 'MARYAM ABBAS', gr_number: '5970' },
        voucher_heads: [
            { vouchers: { id: 793, class_id: 11, status: 'PAID', paid_pdf_url: null } },
        ],
    });

    const build = (opts: { heads?: any[]; atTarget?: any[] } = {}) => {
        const heads = opts.heads ?? [head(2549, 4), head(2550, 5), head(2551, 6)];
        const ids = heads.map((h) => h.id);

        const prisma: any = {
            classes: { findMany: jest.fn().mockResolvedValue(CLASSES) },
            student_fees: {
                findMany: jest.fn().mockImplementation((args: any) => {
                    // Second call looks for heads already at the destination.
                    if (args?.where?.academic_year) return Promise.resolve(opts.atTarget ?? []);
                    return Promise.resolve(heads);
                }),
                updateMany: jest.fn().mockResolvedValue({ count: ids.length }),
            },
            $transaction: jest.fn().mockResolvedValue([{ count: ids.length }]),
        };
        const auditLogs: any = { log: jest.fn(), logGroup: jest.fn() };
        const service = new StudentFeesService(prisma, auditLogs, {} as any);
        return { service, prisma, auditLogs, ids };
    };

    beforeEach(() => resetClassTermMapCache());

    it('shows the corrected calendar year for an Apr-Jul head moved to the next term', async () => {
        const { service, ids } = build();

        const res = await service.transferPreview({
            student_fee_ids: ids,
            target_academic_year: '2026-2027',
            target_term_start_month: 4,
        });

        // The schedule renders these through class 18 (Apr-Mar) and lands a year
        // early; the transfer is what corrects them.
        expect(res.rows.map((r: any) => [r.label_before, r.label_after])).toEqual([
            ['Apr 25', 'Apr 26'],
            ['May 25', 'May 26'],
            ['Jun 25', 'Jun 26'],
        ]);
        expect(res.changes).toBe(3);
        expect(res.unchanged).toBe(0);
    });

    it('reports the voucher label separately when it already disagrees with the schedule', async () => {
        const { service, ids } = build();

        const res = await service.transferPreview({
            student_fee_ids: ids,
            target_academic_year: '2026-2027',
            target_term_start_month: 4,
        });

        // Class 11 (Aug-Jul) issued these, so the voucher already reads Apr 26
        // while the schedule reads Apr 25 — the two surfaces disagree today.
        expect(res.rows.map((r: any) => r.label_on_voucher)).toEqual(['Apr 26', 'May 26', 'Jun 26']);
        expect(res.rows.every((r: any) => r.flags.voucher_label_differs)).toBe(true);
    });

    it('sends the head a year out when the destination term is Aug-Jul instead', async () => {
        const { service, ids } = build();

        const res = await service.transferPreview({
            student_fee_ids: ids,
            target_academic_year: '2026-2027',
            target_term_start_month: 8,
        });

        // This is the trap the DTO exists to prevent: April of an Aug-Jul
        // 2026-2027 term is Apr 2027, a year past where the head belongs.
        expect(res.rows.map((r: any) => r.label_after)).toEqual(['Apr 27', 'May 27', 'Jun 27']);
        expect(res.changes).toBe(3);
    });

    it('warns rather than blocks when the head sits on a paid voucher', async () => {
        const { service, ids } = build();

        const res = await service.transferPreview({
            student_fee_ids: ids,
            target_academic_year: '2026-2027',
            target_term_start_month: 4,
        });

        expect(res.on_paid_voucher).toBe(3);
        expect(res.rows.every((r: any) => r.flags.on_voucher && r.flags.on_paid_voucher)).toBe(true);
        // Nothing is excluded — bulk-delete's "on a voucher => blocked" rule
        // must not leak into transfer, where those are the heads that move.
        expect(res.total).toBe(3);
    });

    it('flags a frozen receipt, whose stored PDF keeps the old label', async () => {
        const frozen = head(2549, 4);
        frozen.voucher_heads = [
            { vouchers: { id: 8793, class_id: 11, status: 'PAID', paid_pdf_url: 'https://cdn/r.pdf' } },
        ];
        const { service } = build({ heads: [frozen] });

        const res = await service.transferPreview({
            student_fee_ids: [2549],
            target_academic_year: '2026-2027',
            target_term_start_month: 4,
        });

        expect(res.frozen_receipts).toBe(1);
        expect(res.rows[0].flags.frozen_receipt).toBe(true);
    });

    it('flags a head already occupying the destination period', async () => {
        const { service } = build({
            heads: [head(2549, 4)],
            atTarget: [{ id: 9522, student_id: 7242, fee_type_id: 1, target_month: 4 }],
        });

        const res = await service.transferPreview({
            student_fee_ids: [2549],
            target_academic_year: '2026-2027',
            target_term_start_month: 4,
        });

        expect(res.collisions).toBe(1);
        expect(res.rows[0].collision_with_fee_id).toBe(9522);
    });

    it('writes academic_year and term_start_month together', async () => {
        const { service, prisma, ids } = build();

        await service.transferHeads({
            student_fee_ids: ids,
            target_academic_year: '2026-2027',
            target_term_start_month: 4,
            acknowledgement: true,
        });

        expect(prisma.student_fees.updateMany).toHaveBeenCalledWith({
            where: { id: { in: ids } },
            data: { academic_year: '2026-2027', term_start_month: 4 },
        });
    });

    it('refuses to transfer without an acknowledgement', async () => {
        const { service, prisma, ids } = build();

        await expect(
            service.transferHeads({
                student_fee_ids: ids,
                target_academic_year: '2026-2027',
                target_term_start_month: 4,
                acknowledgement: false,
            }),
        ).rejects.toThrow(/acknowledgement/i);
        expect(prisma.student_fees.updateMany).not.toHaveBeenCalled();
    });

    it('refuses a term the school does not run', async () => {
        const { service, ids } = build();

        await expect(
            service.transferPreview({
                student_fee_ids: ids,
                target_academic_year: '2026-2027',
                target_term_start_month: 6,
            }),
        ).rejects.toThrow(/must be 4 .*or 8/i);
    });

    it('records the old year and term on every head so the move can be reversed', async () => {
        const { service, auditLogs, ids } = build();

        await service.transferHeads({
            student_fee_ids: ids,
            target_academic_year: '2026-2027',
            target_term_start_month: 4,
            acknowledgement: true,
        });

        expect(auditLogs.logGroup).toHaveBeenCalled();
        const [parent, children] = auditLogs.logGroup.mock.calls[0];
        expect(parent.action).toBe('TRANSFERRED');
        expect(children).toHaveLength(3);
        expect(children[0].old_value).toBe('2025-2026 / term NULL');
        expect(children[0].new_value).toBe('2026-2027 / term 4');
        expect(children[0].note).toMatch(/PAID voucher/);
    });
});
