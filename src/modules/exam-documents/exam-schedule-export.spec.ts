import * as ExcelJS from 'exceljs';
import {
    buildScheduleWorkbook,
    letterDateLabel,
    paperDate,
    ScheduleSheetInput,
    scheduleHeading,
    scheduleRows,
    segmentHeading,
    sessionHeading,
    weekdayOf,
} from './exam-schedule-export';
import { campusOnSheet, inferScheduleLayout, presetRows } from './exam-schedule-layouts';

const base: Omit<ScheduleSheetInput, 'layout' | 'classes' | 'papers'> = {
    title: 'FIRST SEMESTER ASSESSMENTS',
    segmentLine: null,
    academicYear: '2026-2027',
    campusLabel: 'CAMPUS - II',
    campusAddress: 'C - 61, 62, 63, 64 & 65, BLOCK # 13, GULISTAN-E-JAUHAR, KARACHI.',
    referenceNo: 'TAFSS-0001/1',
    letterDate: '2026-10-24',
    notes: ['NO PRE OR POST ASSESSMENT WILL BE CONDUCTED.'],
};

async function sheet(input: ScheduleSheetInput) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildScheduleWorkbook(input)) as any);
    const ws = wb.worksheets[0];
    const texts: string[] = [];
    ws.eachRow((row) => row.eachCell((c) => c.master === c && c.value !== null && c.value !== '' && texts.push(String(c.value))));
    return { ws, texts, images: ws.getImages().length };
}

describe('TAFSD-524 exam schedule export', () => {
    it('writes dates and headings the way the school does', () => {
        expect(weekdayOf('2026-12-11')).toBe('FRIDAY');
        expect(paperDate('2026-12-11')).toBe('11 - 12 - 2026');
        expect(paperDate('2026-12-11', ' – ')).toBe('11 – 12 – 2026');
        expect(letterDateLabel('2026-10-24')).toBe('OCTOBER 24, 2026');
        expect(scheduleHeading('preliminary assessments')).toBe('SCHEDULE OF PRELIMINARY ASSESSMENTS');
        expect(scheduleHeading('PRE - MOCK & FIRST SEMESTER ASSESSMENTS SCHEDULE OF O LEVELS')).toBe(
            'PRE - MOCK & FIRST SEMESTER ASSESSMENTS SCHEDULE OF O LEVELS',
        );
        expect(sessionHeading('2026-2027')).toBe('SESSION : 2026 - 2027');
        expect(sessionHeading('2026-2027', 'O_LEVEL')).toBe('SESSION 2026 - 2027');
        expect(sessionHeading('2026-2027', 'SENIOR')).toBe('SESSION : 2026 – 2027');
        expect(segmentHeading(null, ['IX', 'X'])).toBe('CLASSES IX & X');
        expect(segmentHeading(null, ['VI', 'VII', 'VIII'])).toBe('CLASSES VI, VII & VIII');
        expect(segmentHeading('senior cambridge', ['SR-I'])).toBe('SENIOR CAMBRIDGE');
    });

    it('groups papers by date and time, or by date with a time per class', () => {
        const papers = [
            { class_id: 14, date: '2026-12-11', time: '8:00 - 11:30', subject: 'ECONOMICS P2' },
            { class_id: 14, date: '2026-12-11', time: '12:00 - 1:30', subject: 'CHEMISTRY P1' },
            { class_id: 12, date: '2026-12-11', time: '8:00 – 11:30', subject: 'URDU' },
        ];
        const perClass = scheduleRows(papers, true);
        expect(perClass).toHaveLength(1);
        expect(perClass[0].cells[14]).toEqual({ subject: 'ECONOMICS P2 / CHEMISTRY P1', time: '8:00 - 11:30 / 12:00 - 1:30' });
        expect(perClass[0].cells[12]).toEqual({ subject: 'URDU', time: '8:00 – 11:30' });
        expect(scheduleRows(papers, false)).toHaveLength(3);
    });

    it('Secondary: logos, letter heading, campus, grid, notes, signature and footer', async () => {
        const { texts, images } = await sheet({
            ...base,
            layout: 'SECONDARY',
            title: 'PRELIMINARY ASSESSMENTS',
            classes: [
                { id: 19, description: 'X' },
                { id: 18, description: 'IX' },
            ],
            papers: [
                { class_id: 18, date: '2026-12-12', time: '8:00 - 11:30', subject: 'chemistry practical' },
                { class_id: 18, date: '2026-12-11', time: '8:00 - 11:30', subject: 'PHYSICS PRACTICAL' },
                { class_id: 19, date: '2026-12-11', time: '8:00 - 11:30', subject: 'CHEMISTRY PRACTICAL' },
            ],
        });
        expect(images).toBe(3); // crest, motto, signature
        expect(texts.slice(0, 9)).toEqual([
            'DAY   :  SATURDAY',
            'REF . # : TAFSS-0001/1',
            'DATE :  OCTOBER 24, 2026',
            'THE AMERICAN FOUNDATION SECONDARY SCHOOL',
            'SCHEDULE OF PRELIMINARY ASSESSMENTS',
            'CLASSES IX & X',
            'SESSION : 2026 - 2027',
            'CAMPUS - II',
            'DAY',
        ]);
        const h = texts.indexOf('DAY', 1);
        expect(texts.slice(h, h + 15)).toEqual([
            'DAY', 'DATE', 'ASSESSMENT TIMINGS', 'IX', 'X',
            'FRIDAY', '11 - 12 - 2026', '8:00 - 11:30', 'PHYSICS PRACTICAL', 'CHEMISTRY PRACTICAL',
            'SATURDAY', '12 - 12 - 2026', '8:00 - 11:30', 'CHEMISTRY PRACTICAL', '-',
        ]);
        expect(texts).toContain('NOTE:');
        expect(texts).toContain('●   NO PRE OR POST ASSESSMENT WILL BE CONDUCTED.');
        expect(texts).toContain('The American Foundation Secondary School.');
        expect(texts).toContain('CAMPUS - II : SECONDARY SEGMENT');
        expect(texts).not.toContain('Regards,');
    });

    it('O Levels: serial, a LEVELS band and a timing column beside every level', async () => {
        const { texts, images } = await sheet({
            ...base,
            layout: 'O_LEVEL',
            title: 'PRE - MOCK & FIRST SEMESTER ASSESSMENTS SCHEDULE OF O LEVELS',
            referenceNo: null,
            classes: [
                { id: 12, description: 'O-I' },
                { id: 13, description: 'O-II' },
            ],
            papers: [
                { class_id: 12, date: '2026-12-11', time: '8:00 – 11:30', subject: 'URDU' },
                { class_id: 13, date: '2026-12-11', time: '8 : 00 - 11:30', subject: 'URDU' },
                { class_id: 13, date: '2026-12-22', time: '8 : 00 - 11:30', subject: 'MATHEMATICS' },
            ],
        });
        expect(images).toBe(3);
        expect(texts).toContain('THE AMERICAN FOUNDATION SCHOOL FOR A LEVEL STUDIES');
        expect(texts).toContain('SESSION 2026 - 2027');
        expect(texts).not.toContain('CAMPUS - II');
        const band = texts.indexOf('LEVELS');
        expect(texts.slice(band, band + 18)).toEqual([
            'LEVELS',
            'S. #', 'DAY', 'DATE', 'O-I', 'ASSESSMENT TIMINGS', 'O-II', 'ASSESSMENT TIMINGS',
            '1', 'FRIDAY', '11 - 12 - 2026', 'URDU', '8:00 – 11:30', 'URDU', '8 : 00 - 11:30',
            '2', 'TUESDAY', '22 - 12 - 2026',
        ]);
        expect(texts.slice(band + 18, band + 22)).toEqual(['-', '-', 'MATHEMATICS', '8 : 00 - 11:30']);
        expect(texts).toContain('Regards,');
        expect(texts).toContain('TAFSAL : O & A LEVEL SEGMENT');
    });

    it('Senior and Junior: their own class names, dashes, bands and footers', async () => {
        const senior = await sheet({
            ...base,
            layout: 'SENIOR',
            segmentLine: 'SENIOR CAMBRIDGE',
            classes: [{ id: 9, description: 'SR-I' }],
            papers: [{ class_id: 9, date: '2026-12-11', time: '8:00 – 11:30', subject: 'CHEMISTRY' }],
        });
        const sh = senior.texts.indexOf('S #');
        expect(senior.texts.slice(sh, sh + 10)).toEqual(['S #', 'DAY', 'DATE', 'ASSESSMENT TIMINGS', 'SR - I', '1', 'FRIDAY', '11 – 12 – 2026', '8:00 – 11:30', 'CHEMISTRY']);
        expect(senior.texts).toContain('SESSION : 2026 – 2027');
        expect(senior.texts).toContain('CAMPUS - II : SENIOR CAMBRIDGE SEGMENT');

        const junior = await sheet({
            ...base,
            layout: 'JUNIOR',
            segmentLine: 'LEVELS : JR. I TO JR.V',
            classes: [
                { id: 4, description: 'JR-I' },
                { id: 5, description: 'JR-II' },
            ],
            papers: [{ class_id: 4, date: '2026-12-11', time: '8:00 – 11:30', subject: 'ENGLISH COMPOSITIONS' }],
        });
        const jh = junior.texts.indexOf('S. #');
        expect(junior.texts.slice(jh, jh + 13)).toEqual([
            'S. #', 'DAY', 'DATE', 'LEVELS', 'ASSESSMENT TIMINGS', 'JR. I', 'JR. II',
            '1', 'FRIDAY', '11 – 12 – 2026', '8:00 – 11:30', 'ENGLISH COMPOSITIONS', '-',
        ]);
        expect(junior.texts).toContain('GULISTAN -E- JAUHAR NETWORK  |  NORTH NAZIMABAD NETWORK  |  SCHEME 33 NETWORK');
    });
});

describe('TAFSD-525 layouts and presets', () => {
    it('takes the layout from the classes when none was chosen', () => {
        expect(inferScheduleLayout([18, 19])).toBe('SECONDARY');
        expect(inferScheduleLayout([12, 13, 14])).toBe('O_LEVEL');
        expect(inferScheduleLayout([9, 10, 11])).toBe('SENIOR');
        expect(inferScheduleLayout([4, 5, 6, 7, 8])).toBe('JUNIOR');
        expect(inferScheduleLayout([20, 21])).toBe('SENIOR');
        expect(inferScheduleLayout([14, 18])).toBe('SENIOR');
    });

    it('names Gulistan-e-Johar as the school does, and other campuses by their own name', () => {
        expect(campusOnSheet({ campus_code: 'GEJ', campus_name: 'Gulistan-e-Johar Campus', address: 'x' }).label).toBe('CAMPUS - II');
        const knf = campusOnSheet({ campus_code: 'KNF', campus_name: 'Kaneez Fatima Campus', address: 'B 2 Gulshan E Kaneez Fatima' });
        expect(knf).toEqual({ label: 'KANEEZ FATIMA CAMPUS', address: 'B 2 GULSHAN E KANEEZ FATIMA' });
    });

    it('cleans stored preset rows', () => {
        expect(
            presetRows([
                { time: ' 8:00 ', cells: { '18': ' PHYSICS ', '19': '', x: 'no' }, times: { '18': '9:00' } },
                { time: '8:00', cells: { '18': 'URDU' }, times: {} },
                'junk',
            ]),
        ).toEqual([
            { time: '8:00', cells: { '18': 'PHYSICS' }, times: { '18': '9:00' } },
            { time: '8:00', cells: { '18': 'URDU' } },
        ]);
        expect(presetRows(null)).toEqual([]);
    });
});
