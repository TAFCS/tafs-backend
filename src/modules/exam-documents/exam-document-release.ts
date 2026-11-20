import type { ExamDocType } from './exam-document-rules';

/**
 * TAFSD-544: the words a parent sees when a document is released to the app.
 * Pure, so the service and the specs share one definition.
 */

export const RELEASE_MESSAGE_MAX = 300;

const DOC_NOUN: Record<ExamDocType, string> = {
    STATEMENT_OF_ENTRY: 'statement of entry',
    ADMIT_CARD: 'admit card',
};

/** Words kept as written: roman numerals and codes such as "IX", "AS", "A2", "2026". */
const KEEP_WORD = /^(?:[IVX]+|AS|A2|O-?[IVX]+|\d[\w-]*|[A-Z]+\d[\w-]*)$/;

/** "FIRST SEMESTER ASSESSMENTS" -> "First Semester Assessments"; "IX" and "A2" stay as they are. */
export function titleCaseAssessment(title: string): string {
    return title
        .trim()
        .split(/\s+/)
        .map((w) => (KEEP_WORD.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
        .join(' ');
}

/** The school's message, trimmed, or null when it is empty. */
export function cleanReleaseMessage(message: string | null | undefined): string | null {
    const m = (message ?? '').replace(/\r\n/g, '\n').trim();
    return m ? m.slice(0, RELEASE_MESSAGE_MAX) : null;
}

/** Push title: "Statement of Entry ready" / "Admit Card ready". */
export function releaseTitle(docType: ExamDocType): string {
    return docType === 'ADMIT_CARD' ? 'Admit Card ready' : 'Statement of Entry ready';
}

/**
 * Push body: "Hamza Arif's First Semester Assessments statement of entry is in
 * the app." then the first line of the school's message, if there is one.
 */
export function releaseBody(studentName: string, assessment: string, docType: ExamDocType, message: string | null): string {
    const base = `${studentName.trim()}'s ${titleCaseAssessment(assessment)} ${DOC_NOUN[docType]} is in the app.`;
    const first = message?.split('\n')[0]?.trim();
    return first ? `${base} ${first}` : base;
}

export type ReleaseOutcome = 'RELEASED' | 'ALREADY_RELEASED' | 'NOT_ISSUED' | 'NO_FAMILY' | 'NOT_FOUND';

export const RELEASE_OUTCOME_LABEL: Record<ReleaseOutcome, string> = {
    RELEASED: 'Released',
    ALREADY_RELEASED: 'Already released',
    NOT_ISSUED: 'Not issued yet',
    NO_FAMILY: 'No parent account linked',
    NOT_FOUND: 'Not found, or outside your access',
};

/** What happens to one requested student, from what is known about them. */
export function releaseOutcome(s: {
    found: boolean;
    hasDocument: boolean;
    releasedAt: Date | null;
    familyId: number | null;
}): ReleaseOutcome {
    if (!s.found) return 'NOT_FOUND';
    if (!s.hasDocument) return 'NOT_ISSUED';
    if (s.releasedAt) return 'ALREADY_RELEASED';
    if (!s.familyId) return 'NO_FAMILY';
    return 'RELEASED';
}
