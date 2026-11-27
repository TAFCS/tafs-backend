import { countVoucherStatuses } from './voucher-status-counts';

describe('countVoucherStatuses (TAFSD-617)', () => {
    it('gives waived and partially paid their own buckets, so the cards add up', () => {
        const statuses = ['PAID', 'PAID', 'UNPAID', null, 'PARTIALLY_PAID', 'OVERDUE', 'EXPIRED', 'WAIVED', 'WAIVED', 'VOID'];
        const counts = countVoucherStatuses(statuses.map((status) => ({ status })));
        expect(counts).toEqual({
            paid: 2,
            unpaid: 2,
            partially_paid: 1,
            overdue: 1,
            expired: 1,
            waived: 2,
            void: 1,
        });
        const sum = Object.values(counts).reduce((a, b) => a + b, 0);
        expect(sum).toBe(statuses.length);
    });
});
