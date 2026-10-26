/**
 * Advance widths (per 1000 em) of the PDF standard fonts the sheet PDF uses,
 * taken from pdfkit's AFM data (TAFSD-417), so text can be measured without
 * loading pdfkit, which is ESM. Index = the character's position in CHARS.
 */
const CHARS =
  Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('') +
  '–—·’‘“”';

const WIDTHS: Record<StandardFont, number[]> = {
  'Times-Roman': [
    250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250,
    278, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 278, 278, 564, 564,
    564, 444, 921, 722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611,
    889, 722, 722, 556, 722, 667, 556, 611, 722, 722, 944, 722, 722, 611, 333,
    278, 333, 469, 500, 333, 444, 500, 444, 500, 444, 333, 500, 500, 278, 278,
    500, 278, 778, 500, 500, 500, 500, 333, 389, 278, 500, 500, 722, 500, 500,
    444, 480, 200, 480, 541, 500, 1000, 250, 333, 333, 444, 444,
  ],
  'Times-Bold': [
    250, 333, 555, 500, 500, 1000, 833, 278, 333, 333, 500, 570, 250, 333, 250,
    278, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 333, 333, 570, 570,
    570, 500, 930, 722, 667, 722, 722, 667, 611, 778, 778, 389, 500, 778, 667,
    944, 722, 778, 611, 778, 722, 556, 667, 722, 722, 1000, 722, 722, 667, 333,
    278, 333, 581, 500, 333, 500, 556, 444, 556, 444, 333, 500, 556, 278, 333,
    556, 278, 833, 556, 500, 556, 556, 444, 389, 333, 556, 500, 722, 500, 500,
    444, 394, 220, 394, 520, 500, 1000, 250, 333, 333, 500, 500,
  ],
  Helvetica: [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278,
    278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584,
    584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556,
    833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278,
    278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222,
    500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500,
    500, 334, 260, 334, 584, 556, 1000, 278, 222, 222, 333, 333,
  ],
  'Helvetica-Bold': [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278,
    278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584,
    584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611,
    833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333,
    278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278,
    556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556,
    500, 389, 280, 389, 584, 556, 1000, 278, 278, 278, 500, 500,
  ],
};

export type StandardFont =
  | 'Times-Roman'
  | 'Times-Bold'
  | 'Helvetica'
  | 'Helvetica-Bold';

/** Anything outside the table is measured as the font's widest common glyph, so it is never under-sized. */
const FALLBACK = 1000;

/** The width of `text` in points at `size`. */
export function textWidthPt(
  text: string,
  font: StandardFont,
  size: number,
): number {
  const widths = WIDTHS[font];
  let units = 0;
  for (const ch of text) {
    const i = CHARS.indexOf(ch);
    units += i < 0 ? FALLBACK : widths[i];
  }
  return (units * size) / 1000;
}

/**
 * Lines `text` takes when wrapped greedily at spaces into `width` points. A
 * word wider than the line breaks between letters. react-pdf can also break
 * after hyphens and commas, so this never counts fewer lines than it uses.
 */
export function wrappedLineCount(
  text: string,
  font: StandardFont,
  size: number,
  width: number,
): number {
  const space = textWidthPt(' ', font, size);
  let lines = 0;
  for (const paragraph of text.split('\n')) {
    lines++;
    let used = 0;
    for (const word of paragraph.split(' ')) {
      let w = textWidthPt(word, font, size);
      if (used > 0 && used + space + w <= width) {
        used += space + w;
        continue;
      }
      if (used > 0) lines++;
      while (w > width && width > 0) {
        lines++;
        w -= width;
      }
      used = w;
    }
  }
  return lines;
}
