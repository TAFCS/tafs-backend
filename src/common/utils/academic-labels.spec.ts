import {
    calendarYearOf,
    getConsolidatedMonthsLabel,
    getFullMonthYearLabel,
    getMonthYearLabel,
    monthAbsoluteIndex,
    resolveTermStartMonth,
    termOfHead,
    termRelativeSlot,
} from './academic-labels';

const CAMBRIDGE_CLASS = 11; // SR-III, Aug-Jul
const SECONDARY_CLASS = 17; // VIII, Apr-Mar

describe('resolveTermStartMonth', () => {
    it('prefers the term stamped on the head over the viewing class', () => {
        expect(resolveTermStartMonth({ termStartMonth: 8, classId: SECONDARY_CLASS })).toBe(8);
        expect(resolveTermStartMonth({ termStartMonth: 4, classId: CAMBRIDGE_CLASS })).toBe(4);
    });

    it('falls back to the class term map when the head carries none', () => {
        const classTerms = new Map([[99, 4]]);
        expect(resolveTermStartMonth({ classId: 99, classTerms })).toBe(4);
    });

    it('falls back to the legacy special-class list when no map is supplied', () => {
        expect(resolveTermStartMonth({ classId: SECONDARY_CLASS })).toBe(4);
        expect(resolveTermStartMonth({ classId: CAMBRIDGE_CLASS })).toBe(8);
    });

    it('defaults to Aug-Jul with nothing to go on', () => {
        expect(resolveTermStartMonth()).toBe(8);
        expect(resolveTermStartMonth({})).toBe(8);
    });
});

describe('getMonthYearLabel', () => {
    // The reported bug: a June-2026 head written under a Cambridge class, read
    // back after the student moved to a Secondary (Apr-Mar) class.
    it('labels June of 2025-2026 as Jun 26 on an Aug-Jul term', () => {
        expect(getMonthYearLabel(6, '2025-2026', { termStartMonth: 8 })).toBe('Jun 26');
    });

    it('labels June of 2025-2026 as Jun 25 on an Apr-Mar term', () => {
        expect(getMonthYearLabel(6, '2025-2026', { termStartMonth: 4 })).toBe('Jun 25');
    });

    it('uses the head term even when viewed through a class on the other term', () => {
        const head = { term_start_month: 8 };
        const label = getMonthYearLabel(6, '2025-2026', termOfHead(head, { classId: SECONDARY_CLASS }));
        expect(label).toBe('Jun 26');
    });

    it('reproduces the pre-column behaviour when the head has no term', () => {
        const head = { term_start_month: null };
        expect(getMonthYearLabel(6, '2025-2026', termOfHead(head, { classId: SECONDARY_CLASS }))).toBe('Jun 25');
        expect(getMonthYearLabel(6, '2025-2026', termOfHead(head, { classId: CAMBRIDGE_CLASS }))).toBe('Jun 26');
    });

    it('agrees for months outside Apr-Jul, where the two terms cannot disagree', () => {
        for (const month of [8, 9, 10, 11, 12, 1, 2, 3]) {
            expect(getMonthYearLabel(month, '2025-2026', { termStartMonth: 8 }))
                .toBe(getMonthYearLabel(month, '2025-2026', { termStartMonth: 4 }));
        }
    });

    it('disagrees for exactly Apr-Jul', () => {
        for (const month of [4, 5, 6, 7]) {
            expect(getMonthYearLabel(month, '2025-2026', { termStartMonth: 8 }))
                .not.toBe(getMonthYearLabel(month, '2025-2026', { termStartMonth: 4 }));
        }
    });
});

describe('getFullMonthYearLabel', () => {
    it('spells out the resolved calendar year', () => {
        expect(getFullMonthYearLabel(4, '2026-2027', { termStartMonth: 4 })).toBe('APRIL 2026');
        expect(getFullMonthYearLabel(4, '2026-2027', { termStartMonth: 8 })).toBe('APRIL 2027');
    });
});

describe('calendarYearOf', () => {
    it('returns null for an unparseable academic year', () => {
        expect(calendarYearOf(6, '', { termStartMonth: 8 })).toBeNull();
        expect(calendarYearOf(6, 'nonsense', { termStartMonth: 8 })).toBeNull();
    });
});

describe('monthAbsoluteIndex', () => {
    it('is consecutive across a calendar year boundary', () => {
        const dec = monthAbsoluteIndex(12, '2025-2026', { termStartMonth: 8 })!;
        const jan = monthAbsoluteIndex(1, '2025-2026', { termStartMonth: 8 })!;
        expect(jan).toBe(dec + 1);
    });

    it('orders a term-crossing list by real calendar time', () => {
        // Jun 2026 billed under Cambridge, Jul 2026 under Secondary. Term-relative
        // slots would put these in the wrong order; absolute index must not.
        const jun2026Cambridge = monthAbsoluteIndex(6, '2025-2026', { termStartMonth: 8 })!;
        const jul2026Secondary = monthAbsoluteIndex(7, '2026-2027', { termStartMonth: 4 })!;
        expect(jul2026Secondary).toBe(jun2026Cambridge + 1);
    });
});

describe('termRelativeSlot', () => {
    it('puts the term start at slot 0', () => {
        expect(termRelativeSlot(8, { termStartMonth: 8 })).toBe(0);
        expect(termRelativeSlot(4, { termStartMonth: 4 })).toBe(0);
    });

    it('wraps around the end of the term', () => {
        expect(termRelativeSlot(7, { termStartMonth: 8 })).toBe(11);
        expect(termRelativeSlot(3, { termStartMonth: 4 })).toBe(11);
    });
});

describe('getConsolidatedMonthsLabel', () => {
    it('collapses consecutive months into a range', () => {
        const label = getConsolidatedMonthsLabel([
            { month: 8, academicYear: '2025-2026', term: { termStartMonth: 8 } },
            { month: 9, academicYear: '2025-2026', term: { termStartMonth: 8 } },
            { month: 10, academicYear: '2025-2026', term: { termStartMonth: 8 } },
        ]);
        expect(label).toBe('AUG 25 - OCT 25');
    });

    it('splits non-consecutive months', () => {
        const label = getConsolidatedMonthsLabel([
            { month: 8, academicYear: '2025-2026', term: { termStartMonth: 8 } },
            { month: 1, academicYear: '2025-2026', term: { termStartMonth: 8 } },
        ]);
        expect(label).toBe('AUG 25, JAN 26');
    });

    it('treats a term-crossing pair as one contiguous range', () => {
        const label = getConsolidatedMonthsLabel([
            { month: 7, academicYear: '2026-2027', term: { termStartMonth: 4 } },
            { month: 6, academicYear: '2025-2026', term: { termStartMonth: 8 } },
        ]);
        expect(label).toBe('JUN 26 - JUL 26');
    });

    it('returns an empty string for no items', () => {
        expect(getConsolidatedMonthsLabel([])).toBe('');
    });
});
