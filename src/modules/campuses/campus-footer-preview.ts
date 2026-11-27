import React from 'react';
import { renderToBuffer } from '@react-pdf/renderer';
import {
    CAMPUS_FOOTER_MAX_CHARS,
    CAMPUS_FOOTER_MAX_LINES,
    FOOTER_AREAS,
    FooterArea,
    cleanFooterLines,
    fitFooter,
    footerProblems,
} from '../documents/campus-footer';
import { ExamFooterStripPDF, FOOTER_STRIP_HEIGHT } from '../exam-documents/ExamDocumentPDF';
import { examFooterLines, karachiLong } from '../exam-documents/exam-document-page';
import { SLC_FOOTER_STRIP_HEIGHT, renderSlcFooterStrip, resolveSlcTemplate } from '../enrollments/slc-template';

/**
 * TAFSD-603: the Setup > Campuses preview of a campus's document footer. For each kind of
 * document it renders the bottom of the page with the code that prints it (the exam documents'
 * Footer component, the leaving certificate's own blank with the footer stamped on), and says
 * per line what size it prints at and whether it had to shrink or does not fit at all.
 */

export interface FooterPreviewCampus {
    id: number;
    campus_name: string;
    address: string | null;
    uan_number: string | null;
}

export interface FooterPreviewArea {
    id: FooterArea['id'];
    label: string;
    /** What prints: the draft's lines, or this document's own footer when the draft is empty. */
    source: 'CAMPUS_FOOTER' | 'DOCUMENT_DEFAULT';
    fits: boolean;
    lines: { text: string; size: number; full_size: number; shrunk: boolean; overflow: boolean }[];
    /** Width and height of the strip in points, for the frame it is shown in. */
    width: number;
    height: number;
    pdf_base64: string;
}

export interface FooterPreview {
    lines: string[];
    max_lines: number;
    max_chars: number;
    /** Why these lines cannot be saved; empty when they can. */
    problems: string[];
    areas: FooterPreviewArea[];
}

const fitRows = (lines: string[], area: FooterArea) => {
    const fit = fitFooter(lines, area);
    return {
        fits: fit.fits,
        lines: fit.lines.map((l) => ({ text: l.text, size: l.size, full_size: l.fullSize, shrunk: l.shrunk, overflow: l.overflow })),
    };
};

export async function campusFooterPreview(campus: FooterPreviewCampus, draft: readonly string[]): Promise<FooterPreview> {
    const lines = cleanFooterLines(draft);
    const own = lines.length > 0;

    // Statement of entry / admit card: the campus line, then the footer (or the address, UAN and web line).
    const examLines = examFooterLines({ footer: lines, address: campus.address, uan: campus.uan_number });
    const examPdf = await renderToBuffer(
        React.createElement(ExamFooterStripPDF, {
            d: {
                campusLine: `${campus.campus_name.toUpperCase()} : SECONDARY SEGMENT`,
                footerLines: examLines,
                issuedLong: karachiLong(new Date()),
            },
        }) as any,
    );

    // Leaving certificate: the campus's blank (TAFSAL for Gulistan-e-Jauhar; its TAFSS blank has the same footer band).
    const slcPdf = await renderSlcFooterStrip(resolveSlcTemplate({ campus_id: campus.id }), lines);

    return {
        lines,
        max_lines: CAMPUS_FOOTER_MAX_LINES,
        max_chars: CAMPUS_FOOTER_MAX_CHARS,
        problems: footerProblems(lines),
        areas: [
            {
                id: 'EXAM_DOCUMENT',
                label: FOOTER_AREAS.EXAM_DOCUMENT.label,
                source: own ? 'CAMPUS_FOOTER' : 'DOCUMENT_DEFAULT',
                ...fitRows(examLines, FOOTER_AREAS.EXAM_DOCUMENT),
                width: 595.28,
                height: FOOTER_STRIP_HEIGHT,
                pdf_base64: Buffer.from(examPdf).toString('base64'),
            },
            {
                id: 'LEAVING_CERTIFICATE',
                label: FOOTER_AREAS.LEAVING_CERTIFICATE.label,
                source: own ? 'CAMPUS_FOOTER' : 'DOCUMENT_DEFAULT',
                // The blank's own footer is artwork, not lines this code sets.
                ...(own ? fitRows(lines, FOOTER_AREAS.LEAVING_CERTIFICATE) : { fits: true, lines: [] }),
                width: 595.28,
                height: SLC_FOOTER_STRIP_HEIGHT,
                pdf_base64: Buffer.from(slcPdf).toString('base64'),
            },
        ],
    };
}
