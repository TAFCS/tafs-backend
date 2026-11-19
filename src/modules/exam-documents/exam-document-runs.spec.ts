import * as ExcelJS from 'exceljs';
import { NO_DUES } from './exam-document-rules';
import {
    RunStudent,
    buildRunWorkbook,
    duesSkip,
    eligibilitySkip,
    gapsOf,
    runCounts,
    runLabel,
    sortRunStudents,
} from './exam-document-runs';

const schedule = { campus_id: 2, class_ids: [9, 10] };
const enrolled = { status: 'ENROLLED', campus_id: 2, class_id: 9 };

const row = (over: Partial<RunStudent>): RunStudent => ({
    cc: 1,
    gr: null,
    name: 'A',
    class: 'Sr. I',
    section: 'A',
    outcome: 'ISSUED',
    reason_code: null,
    reason: null,
    owed: null,
    fee_date: null,
    serial: null,
    gaps: [],
    ...over,
});

describe('TAFSD-543 issue run report', () => {
    it('gives every record problem its own reason', () => {
        expect(eligibilitySkip(undefined, schedule)?.code).toBe('NOT_FOUND');
        expect(eligibilitySkip({ ...enrolled, status: 'WITHDRAWN' }, schedule)).toEqual({ code: 'NOT_ENROLLED', reason: 'Not enrolled (WITHDRAWN)' });
        expect(eligibilitySkip({ ...enrolled, campus_id: 3 }, schedule)?.code).toBe('OTHER_CAMPUS');
        expect(eligibilitySkip({ ...enrolled, class_id: 12 }, schedule)?.code).toBe('CLASS_NOT_ON_SCHEDULE');
        expect(eligibilitySkip({ ...enrolled, class_id: null }, schedule)?.code).toBe('CLASS_NOT_ON_SCHEDULE');
        expect(eligibilitySkip(enrolled, schedule)).toBeNull();
    });

    it('says how much is owed, through which fee date and for which months', () => {
        expect(duesSkip(NO_DUES, '2026-12-01')).toBeNull();
        const owing = {
            ...NO_DUES,
            heads_outstanding: 37990,
            head_count: 2,
            months: [
                { fee_date: '2026-10-01', billed: 18995, not_billed: 0 },
                { fee_date: '2026-11-01', billed: 18995, not_billed: 0 },
            ],
        };
        expect(duesSkip(owing, '2026-12-01')).toEqual({
            code: 'DUES_NOT_CLEARED',
            reason: 'Owes Rs 37,990 through 1 Dec 2026 (Oct 2026, Nov 2026)',
            owed: 37990,
        });
        const withSurcharge = duesSkip({ ...owing, surcharge_outstanding: 1000 }, '2026-12-01')!;
        expect(withSurcharge.owed).toBe(38990);
        expect(withSurcharge.reason).toContain('incl. Rs 1,000 surcharge');
    });

    it('tells staff to bill first when a student only owes fees never put on a voucher', () => {
        const unbilled = {
            ...NO_DUES,
            heads_outstanding: 18995,
            not_billed_outstanding: 18995,
            head_count: 1,
            months: [{ fee_date: '2026-12-01', billed: 0, not_billed: 18995 }],
        };
        const out = duesSkip(unbilled, '2026-12-01')!;
        expect(out.code).toBe('NOT_BILLED');
        expect(out.reason).toMatch(/never put on a voucher \(Dec 2026\)\. Generate the voucher first\.$/);
    });

    it('lists what a printed document is missing', () => {
        expect(gapsOf({ has_photo_on_file: true, photo_embedded: true, has_father: true, has_dob: true })).toEqual([]);
        expect(gapsOf({ has_photo_on_file: false, photo_embedded: false, has_father: false, has_dob: false })).toEqual(['NO_PHOTO', 'NO_FATHER', 'NO_DOB']);
        expect(gapsOf({ has_photo_on_file: true, photo_embedded: false, has_father: true, has_dob: true })).toEqual(['PHOTO_UNREADABLE']);
    });

    it('names the run by the classes and sections it covered', () => {
        expect(runLabel([{ class: 'Sr. I', section: 'B' }, { class: 'Sr. I', section: 'A' }, { class: 'Sr. I', section: 'A' }])).toBe('Sr. I – A, Sr. I – B');
        expect(runLabel([])).toBe('No students');
        expect(runLabel([{ class: null, section: null }, { class: 'VI', section: null }])).toBe('VI');
        const many = Array.from({ length: 8 }, (_, i) => ({ class: 'O-I', section: String.fromCharCode(65 + i) }));
        expect(runLabel(many)).toBe('O-I – A, O-I – B, O-I – C, O-I – D, O-I – E, O-I – F and 2 more');
    });

    it('counts outcomes and puts the skipped students first', () => {
        const rows = [
            row({ cc: 1, name: 'Zara', outcome: 'ISSUED', gaps: ['NO_PHOTO'] }),
            row({ cc: 2, name: 'Bilal', outcome: 'SKIPPED', reason_code: 'DUES_NOT_CLEARED' }),
            row({ cc: 3, name: 'Ali', outcome: 'REPRINTED' }),
            row({ cc: 4, name: 'Amna', outcome: 'SKIPPED', reason_code: 'NOT_BILLED' }),
        ];
        expect(runCounts(rows)).toEqual({ requested: 4, issued: 1, reprinted: 1, skipped: 2, with_gaps: 1 });
        expect(sortRunStudents(rows).map((r) => r.cc)).toEqual([4, 2, 1, 3]);
    });

    it('exports one row per student with the reason', async () => {
        const buffer = await buildRunWorkbook({
            scheduleTitle: 'FIRST SEMESTER ASSESSMENTS',
            academicYear: '2026-2027',
            campus: 'Campus # II',
            label: 'Sr. I – A',
            createdBy: 'aawaiz',
            createdAt: '19 Nov 2026, 10:00 am',
            students: [
                row({ cc: 4137, name: 'Hamza Arif', serial: '0007', gaps: ['NO_DOB'] }),
                row({ cc: 7412, name: 'Ayesha Kamran', outcome: 'SKIPPED', reason_code: 'DUES_NOT_CLEARED', reason: 'Owes Rs 18,995 through 1 Dec 2026 (Nov 2026)', owed: 18995, fee_date: '2026-12-01' }),
            ],
        });
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buffer as any);
        const ws = wb.getWorksheet('Report')!;
        expect(ws.getRow(4).getCell(1).value).toBe('Asked for 2: 1 issued, 0 reprinted, 1 not generated, 1 printed with missing details');
        expect(ws.getRow(7).values).toEqual(
            expect.arrayContaining([7412, 'Ayesha Kamran', 'Not generated', 'Owes Rs 18,995 through 1 Dec 2026 (Nov 2026)', 18995, '1 Dec 2026']),
        );
        expect(ws.getRow(8).getCell(11).value).toBe('No date of birth');
    });
});
