import * as ExcelJS from 'exceljs';
import {
    buildScheduleWorkbook,
    letterDateLabel,
    paperDate,
    scheduleHeading,
    segmentHeading,
    sessionHeading,
    weekdayOf,
} from './exam-schedule-export';

describe('TAFSD-524 exam schedule export', () => {
    it('writes dates and headings the way the school does', () => {
        expect(weekdayOf('2026-12-11')).toBe('FRIDAY');
        expect(paperDate('2026-12-11')).toBe('11 - 12 - 2026');
        expect(letterDateLabel('2026-10-24')).toBe('OCTOBER 24, 2026');
        expect(scheduleHeading('preliminary assessments')).toBe('SCHEDULE OF PRELIMINARY ASSESSMENTS');
        expect(scheduleHeading('SCHEDULE OF FINAL MIDTERM')).toBe('SCHEDULE OF FINAL MIDTERM');
        expect(sessionHeading('2026-2027')).toBe('SESSION : 2026 - 2027');
        expect(segmentHeading(null, ['IX', 'X'])).toBe('CLASSES IX & X');
        expect(segmentHeading(null, ['VI', 'VII', 'VIII'])).toBe('CLASSES VI, VII & VIII');
        expect(segmentHeading('senior cambridge', ['SR-I'])).toBe('SENIOR CAMBRIDGE');
    });

    it('lays out the header, the grid and the notes', async () => {
        const buffer = await buildScheduleWorkbook({
            secondary: true,
            title: 'PRELIMINARY ASSESSMENTS',
            segmentLine: null,
            academicYear: '2026-2027',
            campusName: 'Gulistan-e-Johar Campus',
            referenceNo: 'TAFSS-0001/1',
            letterDate: '2026-10-24',
            classes: [
                { id: 19, description: 'X' },
                { id: 18, description: 'IX' },
            ],
            rows: [
                { date: '2026-12-12', time: '8:00 - 11:30', cells: { 18: 'chemistry practical' } },
                { date: '2026-12-11', time: '8:00 - 11:30', cells: { 18: 'PHYSICS PRACTICAL', 19: 'CHEMISTRY PRACTICAL' } },
            ],
            notes: ['NO PRE OR POST ASSESSMENT WILL BE CONDUCTED.'],
            campusLine: 'GULISTAN-E-JOHAR CAMPUS : SECONDARY SEGMENT',
            addressLines: ['C 61-65 block 13 Gulistan e Jauhar'],
        });
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buffer as any);
        const ws = wb.worksheets[0];
        const texts: string[] = [];
        ws.eachRow((row) => row.eachCell((c) => c.master === c && texts.push(String(c.value))));

        expect(texts.slice(0, 4)).toEqual(['DAY   :  SATURDAY', 'REF . # : TAFSS-0001/1', 'DATE :  OCTOBER 24, 2026', 'THE AMERICAN FOUNDATION SECONDARY SCHOOL']);
        expect(texts).toContain('SCHEDULE OF PRELIMINARY ASSESSMENTS');
        expect(texts).toContain('CLASSES IX & X');
        expect(texts).toContain('SESSION : 2026 - 2027');
        // Classes in class order, papers in date order, a class with no paper shows "-".
        const header = texts.indexOf('DAY');
        expect(texts.slice(header, header + 5)).toEqual(['DAY', 'DATE', 'ASSESSMENT TIMINGS', 'IX', 'X']);
        expect(texts.slice(header + 5, header + 15)).toEqual([
            'FRIDAY', '11 - 12 - 2026', '8:00 - 11:30', 'PHYSICS PRACTICAL', 'CHEMISTRY PRACTICAL',
            'SATURDAY', '12 - 12 - 2026', '8:00 - 11:30', 'CHEMISTRY PRACTICAL', '-',
        ]);
        expect(texts).toContain('•   NO PRE OR POST ASSESSMENT WILL BE CONDUCTED.');
        expect(texts).toContain('The American Foundation Secondary School.');
    });

    it('uses the A Level school for any class outside VI–X', async () => {
        const buffer = await buildScheduleWorkbook({
            secondary: false, title: 'FIRST SEMESTER ASSESSMENTS', segmentLine: 'SENIOR CAMBRIDGE', academicYear: '2026-2027',
            campusName: 'Gulistan-e-Johar Campus', referenceNo: null, letterDate: '2026-10-24',
            classes: [{ id: 9, description: 'SR-I' }], rows: [], notes: [], campusLine: '', addressLines: [],
        });
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buffer as any);
        const texts: string[] = [];
        wb.worksheets[0].eachRow((row) => row.eachCell((c) => c.master === c && texts.push(String(c.value))));
        expect(texts).toContain('THE AMERICAN FOUNDATION SCHOOL FOR A LEVEL STUDIES');
        expect(texts).toContain('SENIOR CAMBRIDGE');
        expect(texts.some((t) => t.startsWith('REF'))).toBe(false);
    });
});
