/**
 * TAFSD-555: Adobe's Times-Roman and Times-Bold advance widths (thousandths of an em) for
 * printable ASCII, U+0020 to U+007E. These are the metrics @react-pdf/pdfkit lays the exam
 * documents out with (its StandardFont, generated from it), so a line measured here breaks
 * where the PDF breaks it, give or take kerning (ignored, which only errs wide).
 */
const WIDTHS = {
    r: [
        250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250, 278, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500,
        278, 278, 564, 564, 564, 444, 921, 722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722, 722, 556, 722, 667, 556,
        611, 722, 722, 944, 722, 722, 611, 333, 278, 333, 469, 500, 333, 444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778,
        500, 500, 500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444, 480, 200, 480, 541,
    ],
    b: [
        250, 333, 555, 500, 500, 1000, 833, 278, 333, 333, 500, 570, 250, 333, 250, 278, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500,
        333, 333, 570, 570, 570, 500, 930, 722, 667, 722, 722, 667, 611, 778, 778, 389, 500, 778, 667, 944, 722, 778, 611, 778, 722, 556,
        667, 722, 722, 1000, 722, 722, 667, 333, 278, 333, 581, 500, 333, 500, 556, 444, 556, 444, 333, 500, 556, 278, 333, 556, 278, 833,
        556, 500, 556, 556, 444, 389, 333, 556, 500, 722, 500, 500, 444, 394, 220, 394, 520,
    ],
} as const;

/** Characters outside ASCII that the documents use, same for both weights except where noted. */
const EXTRA: Record<string, number> = {
    '–': 500,
    '—': 1000,
    '‘': 333,
    '’': 333,
    '“': 444,
    '”': 444,
    '•': 350,
    '·': 250,
};

export type TimesWeight = 'r' | 'b';

/** Width of `text` in points at `size`, in Times Roman ('r') or Times Bold ('b'). */
export function timesWidth(text: string, weight: TimesWeight, size: number): number {
    const w = WIDTHS[weight];
    let units = 0;
    for (const ch of text) {
        const c = ch.charCodeAt(0);
        units += c >= 32 && c < 127 ? w[c - 32] : (EXTRA[ch] ?? 1000);
    }
    return (units * size) / 1000;
}

/**
 * Lines `text` takes in a column `width` points wide: words carried whole to the next line,
 * as react-pdf does with hyphenation turned off. A word longer than the column is split.
 */
export function timesLines(text: string, weight: TimesWeight, size: number, width: number): number {
    const words = text.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return 1;
    const space = timesWidth(' ', weight, size);
    let lines = 1;
    let used = 0;
    for (const word of words) {
        const ww = timesWidth(word, weight, size);
        if (used && used + space + ww > width) {
            lines++;
            used = 0;
        }
        if (!used && ww > width) {
            lines += Math.ceil(ww / width) - 1;
            used = ww % width;
        } else used += (used ? space : 0) + ww;
    }
    return lines;
}

/** Line height react-pdf gives Times when the style sets none: (ascent - descent + gap) per em. */
export const TIMES_DEFAULT_LH = { r: 1.116, b: 1.153 } as const;
