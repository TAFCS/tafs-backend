import {
    NO_DUES,
    docTypeForClass,
    endOfMonth,
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

    it('stores the dues month as its last day', () => {
        expect(endOfMonth(2026, 12)).toBe('2026-12-31');
        expect(endOfMonth(2027, 2)).toBe('2027-02-28');
        expect(endOfMonth(2028, 2)).toBe('2028-02-29');
        expect(endOfMonth(2026, 11)).toBe('2026-11-30');
        expect(monthLabel('2026-12-31')).toBe('DECEMBER 2026');
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
        expect(rosterState(false, { ...NO_DUES, heads_outstanding: 9000 })).toBe('BLOCKED');
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
