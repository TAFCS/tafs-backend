import {
    NO_DUES,
    billedOwed,
    docTypeForClass,
    effectiveFeeDate,
    feeDateLabel,
    formatSerial,
    isCleared,
    issueWindowOpen,
    monthLabel,
    rosterState,
    totalOwed,
} from './exam-document-rules';

describe('TAFSD-510 exam document rules', () => {
    it('gives VI–X (15–19) an admit card and every other class a statement of entry', () => {
        for (const id of [15, 16, 17, 18, 19]) expect(docTypeForClass(id)).toBe('ADMIT_CARD');
        for (const id of [1, 4, 8, 9, 11, 12, 14, 20, 21]) expect(docTypeForClass(id)).toBe('STATEMENT_OF_ENTRY');
    });

    it('labels fee dates and months', () => {
        expect(monthLabel('2026-12-01')).toBe('DECEMBER 2026');
        expect(feeDateLabel('2026-12-01')).toBe('1 Dec 2026');
        expect(feeDateLabel('2027-02-28')).toBe('28 Feb 2027');
    });

    it("uses a student's own fee date over the schedule's", () => {
        expect(effectiveFeeDate('2026-12-01', null)).toBe('2026-12-01');
        expect(effectiveFeeDate('2026-12-01', '2026-11-01')).toBe('2026-11-01');
    });

    it('clears a student only when nothing at all is owed, surcharges included', () => {
        expect(isCleared(NO_DUES)).toBe(true);
        expect(isCleared({ ...NO_DUES, heads_outstanding: 1 })).toBe(false);
        expect(isCleared({ ...NO_DUES, surcharge_outstanding: 1000 })).toBe(false);
        expect(totalOwed({ ...NO_DUES, heads_outstanding: 12500.5, surcharge_outstanding: 1000 })).toBe(13500.5);
    });

    it('keeps a holder ISSUED whatever they owe now', () => {
        expect(rosterState(true, { ...NO_DUES, heads_outstanding: 9000 })).toBe('ISSUED');
        expect(rosterState(false, NO_DUES)).toBe('CLEARED');
    });

    it('blocks on billed heads or surcharges, and marks heads never billed as NOT_BILLED', () => {
        // Billed and unpaid: the family has to pay.
        expect(rosterState(false, { ...NO_DUES, heads_outstanding: 9000 })).toBe('BLOCKED');
        // Only heads never put on a voucher: the school has to bill them first.
        const onlyUnbilled = { ...NO_DUES, heads_outstanding: 9000, not_billed_outstanding: 9000 };
        expect(rosterState(false, onlyUnbilled)).toBe('NOT_BILLED');
        expect(isCleared(onlyUnbilled)).toBe(false);
        expect(billedOwed(onlyUnbilled)).toBe(0);
        // Unbilled heads plus a surcharge on a live voucher: the family can pay something now.
        expect(rosterState(false, { ...onlyUnbilled, surcharge_outstanding: 1000 })).toBe('BLOCKED');
        // Billed and unbilled together: BLOCKED.
        const mixed = { ...NO_DUES, heads_outstanding: 15000, not_billed_outstanding: 9000 };
        expect(rosterState(false, mixed)).toBe('BLOCKED');
        expect(billedOwed(mixed)).toBe(6000);
    });

    it('opens issuing on the issue date, not before', () => {
        expect(issueWindowOpen('2026-12-09', '2026-12-08')).toBe(false);
        expect(issueWindowOpen('2026-12-09', '2026-12-09')).toBe(true);
        expect(issueWindowOpen(null, '2026-11-13')).toBe(true);
    });

    it('pads serials to four digits', () => {
        expect(formatSerial(7)).toBe('0007');
        expect(formatSerial(12345)).toBe('12345');
    });
});
