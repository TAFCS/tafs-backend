import {
    FINAL_NOTICE_TEXT,
    PAY_IMMEDIATELY_TEXT,
    REVISED_TEXT,
    voucherStampLines,
} from './voucher-stamp';

const texts = (flags: Parameters<typeof voucherStampLines>[0]) =>
    voucherStampLines(flags).map((l) => l.text);

describe('voucherStampLines (TAFSD-419, TAFSD-420)', () => {
    it('prints nothing on an ordinary voucher', () => {
        expect(texts({})).toEqual([]);
    });

    it('PAY IMMEDIATELY alone', () => {
        expect(texts({ payImmediate: true })).toEqual([PAY_IMMEDIATELY_TEXT]);
    });

    it('REVISED alone is the large form', () => {
        const [line, ...rest] = voucherStampLines({ revised: true });
        expect(rest).toEqual([]);
        expect(line.text).toBe(REVISED_TEXT);
        expect(line.fontSize).toBeGreaterThan(80);
    });

    it('PAY IMMEDIATELY then REVISED', () => {
        expect(texts({ payImmediate: true, revised: true })).toEqual([PAY_IMMEDIATELY_TEXT, REVISED_TEXT]);
    });

    it('a repeat adds the warning under PAY IMMEDIATELY', () => {
        expect(texts({ payImmediate: true, payImmediateRepeat: true })).toEqual([
            PAY_IMMEDIATELY_TEXT,
            FINAL_NOTICE_TEXT,
        ]);
    });

    it('all three print in the agreed order', () => {
        expect(texts({ payImmediate: true, payImmediateRepeat: true, revised: true })).toEqual([
            PAY_IMMEDIATELY_TEXT,
            FINAL_NOTICE_TEXT,
            REVISED_TEXT,
        ]);
    });

    it('the warning never prints without PAY IMMEDIATELY', () => {
        expect(texts({ payImmediateRepeat: true })).toEqual([]);
        expect(texts({ payImmediateRepeat: true, revised: true })).toEqual([REVISED_TEXT]);
    });

    it('uses the exact wording from the ticket', () => {
        expect(FINAL_NOTICE_TEXT).toBe('FINAL NOTICE: SERVICES MAY BE SUSPENDED');
    });
});
