import { TimesWeight, timesWidth } from './times-metrics';

/**
 * TAFSD-603: the footer a campus's official documents print, set in Setup > Campuses
 * (`campuses.document_footer`, one entry a line).
 *
 * This folder holds what every official document shares about the school's own identity: the
 * Times metrics the PDFs are laid out with and the campus footer. TAFSD-623 (the school name in
 * the school font at the top of every document) belongs here too, as a heading beside this
 * footer, so each document keeps reading its header and footer from one place.
 *
 * A footer line never wraps. Each line is measured with the font the document prints it in and
 * shrinks until it fits the width of the document's footer area; a line that still does not fit
 * at the smallest size overflows, and saving refuses it. Because lines never wrap, a footer's
 * height is fixed by its line count, so the pages the footer sits on keep their layout.
 *
 * Which documents print it, and what prints when it is empty:
 *   - statement of entry and admit card: the campus name line, then these lines. Empty: the
 *     campus address with its UAN, and the school's emails and website (TAFSD-528, TAFSD-549).
 *   - leaving certificate: these lines replace the footer printed on the school's blank. Empty:
 *     the blank's own footer is left as it is.
 */

export const CAMPUS_FOOTER_MAX_LINES = 3;
export const CAMPUS_FOOTER_MAX_CHARS = 160;

export type FooterAreaId = 'EXAM_DOCUMENT' | 'LEAVING_CERTIFICATE';

export interface FooterArea {
    id: FooterAreaId;
    /** What the admin sees the area called. */
    label: string;
    /** Width a line may take, in points. */
    width: number;
    weight: TimesWeight;
    /** The size a line prints at when it fits. */
    size: number;
    /** Lines shrink down to this; past it a line overflows. */
    minSize: number;
}

/** Inside the exam documents' frame (A4, 18pt page padding, 1.2pt border, 16pt padding) and the footer box (0.9pt border, 6pt padding). */
const EXAM_FOOTER_WIDTH = 595.28 - 2 * 18 - 2 * 1.2 - 2 * 16 - 2 * 0.9 - 2 * 6;

/**
 * The leaving certificate blanks' footer sits under the frame, whose sides are at x 47.99 and
 * 545.37 on all four blanks (measured off their content streams, slc-template.ts). A few points
 * in from each side.
 */
const SLC_FOOTER_WIDTH = 545.37 - 47.99 - 2 * 4;

export const FOOTER_AREAS: Record<FooterAreaId, FooterArea> = {
    EXAM_DOCUMENT: {
        id: 'EXAM_DOCUMENT',
        label: 'Statement of entry and admit card',
        width: EXAM_FOOTER_WIDTH,
        weight: 'r',
        size: 7.5,
        minSize: 6,
    },
    LEAVING_CERTIFICATE: {
        id: 'LEAVING_CERTIFICATE',
        label: 'Leaving certificate',
        width: SLC_FOOTER_WIDTH,
        weight: 'b',
        size: 9.5,
        minSize: 6.5,
    },
};

/**
 * Characters the documents' fonts can print. The PDFs use the standard Times faces, which have
 * printable ASCII and a few typographic marks; anything else prints as nothing or, on a leaving
 * certificate, cannot be written at all.
 */
const PRINTABLE_EXTRA = new Set(['–', '—', '‘', '’', '“', '”', '•', '·']);

export function unprintableChars(text: string): string[] {
    const bad = new Set<string>();
    for (const ch of text) {
        const c = ch.charCodeAt(0);
        if (!((c >= 32 && c < 127) || PRINTABLE_EXTRA.has(ch))) bad.add(ch);
    }
    return [...bad];
}

/** Lines as stored: each trimmed, runs of spaces kept to one, empty lines dropped. */
export function cleanFooterLines(lines?: readonly (string | null | undefined)[] | null): string[] {
    return (lines ?? []).map((l) => (l ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
}

export interface FooterLineFit {
    text: string;
    /** The size the line prints at. */
    size: number;
    /** The size it would print at with room to spare. */
    fullSize: number;
    shrunk: boolean;
    /** Wider than the area even at the smallest size. */
    overflow: boolean;
    /** Width at `size`, in points. */
    width: number;
}

/** The size a line prints at in an area: full size, or shrunk in 0.1pt steps until it fits. */
export function fitFooterLine(text: string, area: FooterArea): FooterLineFit {
    const full = timesWidth(text, area.weight, area.size);
    if (full <= area.width) return { text, size: area.size, fullSize: area.size, shrunk: false, overflow: false, width: full };
    const size = Math.floor(((area.size * area.width) / full) * 10) / 10;
    if (size >= area.minSize) {
        return { text, size, fullSize: area.size, shrunk: true, overflow: false, width: timesWidth(text, area.weight, size) };
    }
    return {
        text,
        size: area.minSize,
        fullSize: area.size,
        shrunk: true,
        overflow: true,
        width: timesWidth(text, area.weight, area.minSize),
    };
}

export interface FooterFit {
    area: FooterArea;
    lines: FooterLineFit[];
    /** Every line fits on one line of the area. */
    fits: boolean;
}

export function fitFooter(lines: readonly string[], area: FooterArea): FooterFit {
    const fitted = lines.map((l) => fitFooterLine(l, area));
    return { area, lines: fitted, fits: fitted.every((l) => !l.overflow) };
}

/** Why a footer cannot be saved, one message a problem; empty when it can. */
export function footerProblems(lines: readonly string[]): string[] {
    const problems: string[] = [];
    if (lines.length > CAMPUS_FOOTER_MAX_LINES) {
        problems.push(`The footer can have at most ${CAMPUS_FOOTER_MAX_LINES} lines; it has ${lines.length}.`);
    }
    lines.forEach((line, i) => {
        if (line.length > CAMPUS_FOOTER_MAX_CHARS) {
            problems.push(`Line ${i + 1} is ${line.length} characters; at most ${CAMPUS_FOOTER_MAX_CHARS}.`);
        }
        const bad = unprintableChars(line);
        if (bad.length) {
            problems.push(`Line ${i + 1} has characters the documents cannot print: ${bad.map((c) => `"${c}"`).join(' ')}.`);
        }
    });
    for (const area of Object.values(FOOTER_AREAS)) {
        fitFooter(lines, area).lines.forEach((l, i) => {
            if (l.overflow) problems.push(`Line ${i + 1} is too long for the ${area.label.toLowerCase()} footer, even at the smallest size. Shorten it or split it.`);
        });
    }
    return problems;
}
