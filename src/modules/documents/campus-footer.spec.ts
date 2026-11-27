import {
    CAMPUS_FOOTER_MAX_CHARS,
    FOOTER_AREAS,
    cleanFooterLines,
    fitFooter,
    fitFooterLine,
    footerProblems,
    unprintableChars,
} from './campus-footer';
import { timesWidth } from './times-metrics';

const GEJ = [
    'C-61, 62, 63, 64 & 65, BLOCK - 13, GULISTAN-E-JAUHAR, KARACHI, PAKISTAN.',
    'Phone: 3461-2878, 3461-2879, 3461-2880 · Fax: (92-21) 3461-2881 · Helpline: 0300-8258061',
    'E-mail: american@cyber.net.pk · info@tafs.edu.pk · Website: www.tafs.edu.pk',
];

describe('TAFSD-603 campus document footer', () => {
    it('stores lines trimmed, single-spaced, without blank lines', () => {
        expect(cleanFooterLines(['  C-61,   Block 13 ', '', '   ', null, undefined, 'www.tafs.edu.pk'])).toEqual(['C-61, Block 13', 'www.tafs.edu.pk']);
        expect(cleanFooterLines(null)).toEqual([]);
    });

    it('prints a line that fits at full size', () => {
        for (const area of Object.values(FOOTER_AREAS)) {
            const fit = fitFooter(GEJ, area);
            expect(fit.fits).toBe(true);
            expect(fit.lines.map((l) => [l.size, l.shrunk])).toEqual(GEJ.map(() => [area.size, false]));
        }
    });

    it('shrinks a long line just enough to fit the area, never wrapping it', () => {
        const area = FOOTER_AREAS.LEAVING_CERTIFICATE;
        const line = 'E-mail: american@cyber.net.pk · info@tafs.edu.pk · admissions@tafs.edu.pk · Website: www.tafs.edu.pk · Facebook: /tafs.official';
        const fit = fitFooterLine(line, area);
        expect(fit).toMatchObject({ shrunk: true, overflow: false, fullSize: 9.5 });
        expect(fit.size).toBeLessThan(9.5);
        expect(fit.size).toBeGreaterThanOrEqual(area.minSize);
        expect(timesWidth(line, 'b', fit.size)).toBeLessThanOrEqual(area.width);
        // A tenth of a point larger would not fit.
        expect(timesWidth(line, 'b', fit.size + 0.1)).toBeGreaterThan(area.width);
    });

    it('overflows a line too wide even at the smallest size', () => {
        const fit = fitFooterLine(GEJ.join(' '), FOOTER_AREAS.EXAM_DOCUMENT);
        expect(fit).toMatchObject({ overflow: true, size: FOOTER_AREAS.EXAM_DOCUMENT.minSize });
        expect(fitFooter([GEJ[0], GEJ.join(' ')], FOOTER_AREAS.EXAM_DOCUMENT).fits).toBe(false);
    });

    it('accepts the footers printed on the school blanks', () => {
        expect(footerProblems(GEJ)).toEqual([]);
        expect(footerProblems([])).toEqual([]);
    });

    it('refuses more than three lines, an over-long line, an overflow and characters the fonts lack', () => {
        expect(footerProblems([...GEJ, 'One more'])).toEqual([expect.stringContaining('at most 3 lines')]);
        const long = 'W'.repeat(CAMPUS_FOOTER_MAX_CHARS + 1);
        expect(footerProblems([long]).join(' ')).toContain(`at most ${CAMPUS_FOOTER_MAX_CHARS}`);
        // Within the character limit, but too wide even at the smallest size.
        const wide = footerProblems(['W'.repeat(120)]).join(' ');
        expect(wide).toMatch(/too long for the statement of entry and admit card footer/);
        expect(wide).toMatch(/too long for the leaving certificate footer/);
        expect(footerProblems(['پتہ: کراچی'])).toEqual([expect.stringContaining('characters the documents cannot print')]);
        expect(unprintableChars('Phone · Fax – “TAFS” •')).toEqual([]);
        expect(unprintableChars('☎ 3461-2878')).toEqual(['☎']);
    });
});
