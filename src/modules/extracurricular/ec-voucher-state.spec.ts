import { ecStateWhere, ecVoucherIsLapsed, ecVoucherIsLive, ecVoucherState } from './ec-voucher-state';

describe('EC voucher state (TAFSD-605)', () => {
    const today = '2026-11-27';
    const v = (status: string, expiry: string, reissued = false) => ({
        status,
        expiry_date: new Date(`${expiry}T00:00:00Z`),
        reissued_to: reissued ? { id: 99 } : null,
    });

    it('keeps PAID and WAIVED whatever the date', () => {
        expect(ecVoucherState(v('PAID', '2026-01-01'), today)).toBe('PAID');
        expect(ecVoucherState(v('WAIVED', '2026-01-01'), today)).toBe('WAIVED');
    });

    it('treats the expiry day itself as still valid', () => {
        expect(ecVoucherState(v('UNPAID', '2026-11-27'), today)).toBe('UNPAID');
        expect(ecVoucherState(v('PARTIALLY_PAID', '2026-11-27'), today)).toBe('PARTIALLY_PAID');
        expect(ecVoucherState(v('UNPAID', '2026-11-26'), today)).toBe('EXPIRED');
        expect(ecVoucherState(v('PARTIALLY_PAID', '2026-11-26'), today)).toBe('EXPIRED');
    });

    it('shows a reissued voucher as REISSUED, ahead of EXPIRED', () => {
        expect(ecVoucherState(v('UNPAID', '2026-10-01', true), today)).toBe('REISSUED');
        expect(ecVoucherState(v('PARTIALLY_PAID', '2026-10-01', true), today)).toBe('REISSUED');
    });

    it('calls a voucher live only while it can take money', () => {
        expect(ecVoucherIsLive('UNPAID')).toBe(true);
        expect(ecVoucherIsLive('PARTIALLY_PAID')).toBe(true);
        for (const s of ['PAID', 'WAIVED', 'EXPIRED', 'REISSUED'] as const) expect(ecVoucherIsLive(s)).toBe(false);
        expect(ecVoucherIsLapsed('EXPIRED')).toBe(true);
        expect(ecVoucherIsLapsed('REISSUED')).toBe(false);
    });

    it('builds list filters that agree with the shown state', () => {
        const d = new Date(`${today}T00:00:00Z`);
        expect(ecStateWhere([], d)).toBeUndefined();
        const where = ecStateWhere(['EXPIRED', 'UNPAID', 'REISSUED', 'PAID'], d)!;
        expect(where.OR).toEqual(
            expect.arrayContaining([
                { status: { in: ['UNPAID', 'PARTIALLY_PAID'] }, reissued_to: { is: null }, expiry_date: { lt: d } },
                { status: 'UNPAID', reissued_to: { is: null }, expiry_date: { gte: d } },
                { status: { in: ['UNPAID', 'PARTIALLY_PAID'] }, reissued_to: { isNot: null } },
                { status: 'PAID' },
            ]),
        );
        expect(where.OR).toHaveLength(4);
    });
});
