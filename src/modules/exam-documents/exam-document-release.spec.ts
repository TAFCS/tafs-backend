import { cleanReleaseMessage, releaseBody, releaseOutcome, releaseTitle, titleCaseAssessment } from './exam-document-release';

describe('TAFSD-544 release to the parent app', () => {
    it('titles the push by document type', () => {
        expect(releaseTitle('STATEMENT_OF_ENTRY')).toBe('Statement of Entry ready');
        expect(releaseTitle('ADMIT_CARD')).toBe('Admit Card ready');
    });

    it('writes the body in plain words, with the first line of the message', () => {
        expect(releaseBody('Hamza Arif', 'FIRST SEMESTER ASSESSMENTS', 'STATEMENT_OF_ENTRY', null)).toBe(
            "Hamza Arif's First Semester Assessments statement of entry is in the app.",
        );
        expect(releaseBody('Sara Arif', 'PRELIMINARY ASSESSMENTS', 'ADMIT_CARD', 'Bring this every day.\nGates close at 7:45.')).toBe(
            "Sara Arif's Preliminary Assessments admit card is in the app. Bring this every day.",
        );
    });

    it('keeps roman numerals and codes in the assessment title', () => {
        expect(titleCaseAssessment('MOCK EXAMINATIONS IX 2026')).toBe('Mock Examinations IX 2026');
        expect(titleCaseAssessment('  AS  MID-TERM ')).toBe('AS Mid-term');
    });

    it('treats an empty message as none and caps a long one', () => {
        expect(cleanReleaseMessage('   ')).toBeNull();
        expect(cleanReleaseMessage(undefined)).toBeNull();
        expect(cleanReleaseMessage('  Hello\r\nthere ')).toBe('Hello\nthere');
        expect(cleanReleaseMessage('x'.repeat(400))).toHaveLength(300);
    });

    it('releases only an issued, unreleased document of a student with a parent account', () => {
        const base = { found: true, hasDocument: true, releasedAt: null, familyId: 7 };
        expect(releaseOutcome(base)).toBe('RELEASED');
        expect(releaseOutcome({ ...base, found: false })).toBe('NOT_FOUND');
        expect(releaseOutcome({ ...base, hasDocument: false })).toBe('NOT_ISSUED');
        expect(releaseOutcome({ ...base, releasedAt: new Date() })).toBe('ALREADY_RELEASED');
        expect(releaseOutcome({ ...base, familyId: null })).toBe('NO_FAMILY');
    });
});
