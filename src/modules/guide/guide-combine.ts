import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFFont,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFPage,
  PDFRef,
  StandardFonts,
  rgb,
} from 'pdf-lib';
import type { GuideModule } from './guide.types';

/**
 * TAFSD-616: joins bare module PDFs (built by tafs-software-manual with
 * `\usepackage[bare]{tafs-manual}`: no cover, no contents, no page number)
 * into one A4 document that reads like the LaTeX builds: a cover, a contents
 * page, the modules numbered straight through in the footer, and bookmarks.
 *
 * Fonts are the PDF standard Times faces, the nearest built-in match for the
 * manual's Latin Modern; the LaTeX pages themselves are copied untouched.
 */

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 72; // 1in, as tafs-manual.sty's geometry
const TAFS_BLUE = rgb(0x1f / 255, 0x3a / 255, 0x68 / 255);
const GREY = rgb(0.4, 0.4, 0.4);
/** Footer baseline: geometry's 1in bottom margin less article's 30pt \footskip. */
const FOOTER_Y = 42;
const FOOTER_SIZE = 10; // \small at 11pt
const HEADER_Y = A4[1] - MARGIN + 10;

export type CombineSection = { areaTitle: string; module: GuideModule; doc: PDFDocument };

/** WinAnsi-only text: the standard fonts cannot draw an arrow or a smart quote. */
function safe(font: PDFFont, text: string): string {
  const mapped = text
    .replace(/→/g, '>')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"');
  let out = '';
  for (const ch of mapped) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += '?';
    }
  }
  return out;
}

function centered(page: PDFPage, font: PDFFont, text: string, size: number, y: number, color = rgb(0, 0, 0)) {
  const t = safe(font, text);
  page.drawText(t, { x: (A4[0] - font.widthOfTextAtSize(t, size)) / 2, y, size, font, color });
}

/** Wraps text to a width; the cover's subtitle and long titles need it. */
function wrap(font: PDFFont, text: string, size: number, width: number): string[] {
  const words = safe(font, text).split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (line && font.widthOfTextAtSize(next, size) > width) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function header(page: PDFPage, regular: PDFFont) {
  const size = 10;
  page.drawText('TAFSync Software Manual', { x: MARGIN, y: HEADER_Y, size, font: regular });
  const right = 'The American Foundation School';
  page.drawText(right, { x: A4[0] - MARGIN - regular.widthOfTextAtSize(right, size), y: HEADER_Y, size, font: regular });
  page.drawLine({
    start: { x: MARGIN, y: HEADER_Y - 4 },
    end: { x: A4[0] - MARGIN, y: HEADER_Y - 4 },
    thickness: 0.4,
  });
}

type OutlineItem = { title: string; page: PDFRef; children?: OutlineItem[] };

/** pdf-lib has no outline API; this writes the /Outlines tree by hand. */
function writeOutline(doc: PDFDocument, items: OutlineItem[]) {
  const ctx = doc.context;
  const rootRef = ctx.nextRef();

  const build = (list: OutlineItem[], parent: PDFRef): { first: PDFRef; last: PDFRef; count: number } => {
    const refs = list.map(() => ctx.nextRef());
    let count = 0;
    list.forEach((item, i) => {
      const dict = ctx.obj({}) as PDFDict;
      dict.set(PDFName.of('Title'), PDFHexString.fromText(item.title));
      dict.set(PDFName.of('Parent'), parent);
      dict.set(PDFName.of('Dest'), ctx.obj([item.page, PDFName.of('Fit')]) as PDFArray);
      if (i > 0) dict.set(PDFName.of('Prev'), refs[i - 1]);
      if (i < list.length - 1) dict.set(PDFName.of('Next'), refs[i + 1]);
      count += 1;
      if (item.children?.length) {
        const sub = build(item.children, refs[i]);
        dict.set(PDFName.of('First'), sub.first);
        dict.set(PDFName.of('Last'), sub.last);
        dict.set(PDFName.of('Count'), PDFNumber.of(sub.count)); // open
        count += sub.count;
      }
      ctx.assign(refs[i], dict);
    });
    return { first: refs[0], last: refs[refs.length - 1], count };
  };

  const top = build(items, rootRef);
  ctx.assign(
    rootRef,
    ctx.obj({ Type: 'Outlines', First: top.first, Last: top.last, Count: PDFNumber.of(top.count) }),
  );
  doc.catalog.set(PDFName.of('Outlines'), rootRef);
  doc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
}

const CONTENTS_TOP = A4[1] - MARGIN - 50;
const LINE = 18;
const LINES_PER_PAGE = Math.floor((CONTENTS_TOP - MARGIN - 20) / LINE);

export async function buildCombinedGuide(
  sections: CombineSection[],
  opts: { title: string; subtitle: string; date: Date },
): Promise<Uint8Array> {
  if (!sections.length) throw new Error('nothing to combine');
  const out = await PDFDocument.create();
  out.setTitle(`${opts.title}: ${opts.subtitle}`);
  out.setAuthor('TAFS IT and Software Department');
  out.setCreator('TAFSync Guide');
  const regular = await out.embedFont(StandardFonts.TimesRoman);
  const bold = await out.embedFont(StandardFonts.TimesRomanBold);

  // Contents lines: an area heading whenever the area changes, then its modules.
  type Line = { text: string; area: boolean; section: number };
  const lines: Line[] = [];
  sections.forEach((s, i) => {
    if (i === 0 || sections[i - 1].areaTitle !== s.areaTitle) lines.push({ text: s.areaTitle, area: true, section: i });
    lines.push({ text: s.module.title, area: false, section: i });
  });
  const contentsPages = Math.max(1, Math.ceil(lines.length / LINES_PER_PAGE));

  // --- Cover ------------------------------------------------------------------
  const cover = out.addPage(A4);
  let y = A4[1] / 2 + 90;
  for (const l of wrap(bold, opts.title, 30, A4[0] - 2 * MARGIN)) {
    centered(cover, bold, l, 30, y, TAFS_BLUE);
    y -= 36;
  }
  y -= 4;
  for (const l of wrap(regular, opts.subtitle, 18, A4[0] - 2 * MARGIN)) {
    centered(cover, regular, l, 18, y);
    y -= 24;
  }
  y -= 30;
  centered(cover, regular, 'The American Foundation School (TAFS)', 14, y);
  centered(cover, regular, 'TAFS IT and Software Department', 14, y - 18);
  const date = opts.date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Karachi' });
  centered(cover, regular, date, 14, y - 48);

  // --- Contents pages (filled in once page numbers are known) ----------------
  const contents: PDFPage[] = [];
  for (let i = 0; i < contentsPages; i++) contents.push(out.addPage(A4));

  // --- Modules ----------------------------------------------------------------
  const firstPageOf: PDFRef[] = [];
  const startNumber: number[] = [];
  let number = 1;
  for (const s of sections) {
    const copied = await out.copyPages(s.doc, s.doc.getPageIndices());
    startNumber.push(number);
    copied.forEach((p, i) => {
      out.addPage(p);
      if (i === 0) firstPageOf.push(p.ref);
      const label = String(number++);
      p.drawText(label, {
        x: (p.getWidth() - regular.widthOfTextAtSize(label, FOOTER_SIZE)) / 2,
        y: FOOTER_Y,
        size: FOOTER_SIZE,
        font: regular,
      });
    });
  }

  // --- Contents ---------------------------------------------------------------
  contents.forEach((page, pi) => {
    header(page, regular);
    let cy = CONTENTS_TOP;
    if (pi === 0) {
      page.drawText('Contents', { x: MARGIN, y: CONTENTS_TOP + 14, size: 22, font: bold, color: TAFS_BLUE });
      cy -= 30;
    }
    const slice = lines.slice(pi * LINES_PER_PAGE, (pi + 1) * LINES_PER_PAGE);
    for (const line of slice) {
      const font = line.area ? bold : regular;
      const size = line.area ? 13 : 11;
      const indent = line.area ? 0 : 18;
      const num = String(startNumber[line.section]);
      const right = A4[0] - MARGIN;
      const numWidth = font.widthOfTextAtSize(num, size);
      const maxText = right - numWidth - 24 - (MARGIN + indent);
      let text = safe(font, line.text);
      if (font.widthOfTextAtSize(text, size) > maxText) {
        while (text.length > 1 && font.widthOfTextAtSize(`${text}…`, size) > maxText) text = text.slice(0, -1);
        text = `${text.trimEnd()}…`;
      }
      if (line.area) cy -= 6;
      page.drawText(text, { x: MARGIN + indent, y: cy, size, font, color: line.area ? TAFS_BLUE : rgb(0, 0, 0) });
      if (!line.area) {
        const dotsStart = MARGIN + indent + font.widthOfTextAtSize(text, size) + 6;
        const dotsEnd = right - numWidth - 6;
        const dot = regular.widthOfTextAtSize('. ', size);
        const dots = Math.max(0, Math.floor((dotsEnd - dotsStart) / dot));
        if (dots > 0) {
          page.drawText('. '.repeat(dots), { x: dotsEnd - dots * dot, y: cy, size, font: regular, color: GREY });
        }
      }
      page.drawText(num, { x: right - numWidth, y: cy, size, font });
      cy -= LINE;
    }
  });

  // --- Bookmarks ----------------------------------------------------------------
  const outline: OutlineItem[] = [{ title: 'Contents', page: contents[0].ref }];
  sections.forEach((s, i) => {
    const item = { title: s.module.title, page: firstPageOf[i] };
    const last = outline[outline.length - 1];
    if (i > 0 && sections[i - 1].areaTitle === s.areaTitle) last.children!.push(item);
    else outline.push({ title: s.areaTitle, page: firstPageOf[i], children: [item] });
  });
  writeOutline(out, outline);

  return out.save();
}
