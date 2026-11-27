import React from 'react';
import { renderToBuffer } from '@react-pdf/renderer';
import { ExamDocPage, ExamFrontPagePDF, FULL_NOTE_SIZE, frontFit, FrontFit } from './ExamDocumentPDF';

/**
 * TAFSD-555: the front note is measured with the PDF's own font metrics (times-metrics.ts), but
 * only a render proves the front page holds on one sheet. settleFrontFit renders the front page,
 * and while it spills onto a second sheet takes room from the note and the paper rows a step
 * at a time. Every document of a class shares its papers and front note, so the service settles
 * one page per class and gives the rest the same slack; the editor's preview runs the same code,
 * which is why what it shows is what prints.
 */

/** Points of room taken back per step when a rendered front page still spills over. */
export const SLACK_STEP = 12;
/** More than this and even the smallest note and rows cannot fit: the note is too long. */
const MAX_SLACK = 20 * SLACK_STEP;

/** Pages in a PDF react-pdf wrote (its page objects are not compressed). An empty buffer has none. */
export function pdfPageCount(pdf: Buffer): number {
    return (pdf.toString('latin1').match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
}

export async function renderFrontPage(d: ExamDocPage, title?: string): Promise<Buffer> {
    return Buffer.from(await renderToBuffer(React.createElement(ExamFrontPagePDF, { d, title }) as any));
}

export interface SettledFront {
    /** Room taken back from the measured fit; 0 when the measurement held. */
    slack: number;
    /** False when the front page spills onto a second sheet even at the smallest sizes. */
    fits: boolean;
    fit: FrontFit;
    /** Size the note prints at when nothing has to shrink. */
    fullNoteSize: number;
    /** The last front page rendered, at `slack`. */
    pdf: Buffer;
}

export async function settleFrontFit(
    d: ExamDocPage,
    render: (d: ExamDocPage) => Promise<Buffer> = renderFrontPage,
): Promise<SettledFront> {
    const fullNoteSize = FULL_NOTE_SIZE[d.docType];
    let slack = 0;
    let fit = frontFit({ ...d, frontSlack: 0 });
    let pdf = await render({ ...d, frontSlack: 0 });
    // The standard lines keep the TAFSD-528 layout, which never needed this.
    if (!d.frontNotes.length) return { slack: 0, fits: pdfPageCount(pdf) <= 1, fit, fullNoteSize, pdf };
    while (pdfPageCount(pdf) > 1) {
        let next = slack;
        let nextFit = fit;
        // Skip steps that would print the same page.
        do {
            next += SLACK_STEP;
            nextFit = frontFit({ ...d, frontSlack: next });
        } while (next <= MAX_SLACK && sameFit(nextFit, fit));
        if (next > MAX_SLACK) return { slack, fits: false, fit, fullNoteSize, pdf };
        slack = next;
        fit = nextFit;
        pdf = await render({ ...d, frontSlack: slack });
    }
    return { slack, fits: true, fit, fullNoteSize, pdf };
}

const sameFit = (a: FrontFit, b: FrontFit) => a.pv === b.pv && a.size === b.size && a.noteSize === b.noteSize;
