import * as path from 'path';

/**
 * TAFSD-524 / TAFSD-525: the four ways the school lays out an exam schedule,
 * each copied from one of its own sheets. They differ in logos, school name,
 * columns, fonts, note style and footer, and the class group alone does not
 * always decide which one a schedule uses, so the schedule stores its layout.
 *
 *   SECONDARY  VI–X           SCHEDULE OF PRELIMINARY.xls, …FINAL MID TERM….xls
 *   O_LEVEL    O-I – O-III    PRE-MOCKS & FIRST SEMESTER.xls (a timing column per level)
 *   SENIOR     SR-I – SR-III  FIRST SEMESTER SCHEDULE SR.I - SR.III.doc
 *   JUNIOR     JR-I – JR-V    SCHEDULE OF FIRST SEMESTER JRS.doc
 */

export const SCHEDULE_LAYOUTS = ['SECONDARY', 'O_LEVEL', 'SENIOR', 'JUNIOR'] as const;
export type ScheduleLayout = (typeof SCHEDULE_LAYOUTS)[number];

export const SCHEDULE_LAYOUT_LABELS: Record<ScheduleLayout, string> = {
    SECONDARY: 'Secondary (VI–X)',
    O_LEVEL: 'O Levels',
    SENIOR: 'Senior Cambridge',
    JUNIOR: 'Junior Cambridge',
};

export const isScheduleLayout = (v: unknown): v is ScheduleLayout =>
    typeof v === 'string' && (SCHEDULE_LAYOUTS as readonly string[]).includes(v);

/** The layout a schedule takes when none was chosen: the one its classes belong to. */
export function inferScheduleLayout(classIds: number[]): ScheduleLayout {
    if (!classIds.length) return 'SECONDARY';
    const all = (lo: number, hi: number) => classIds.every((id) => id >= lo && id <= hi);
    if (all(15, 19)) return 'SECONDARY';
    if (all(12, 14)) return 'O_LEVEL';
    if (all(4, 8)) return 'JUNIOR';
    return 'SENIOR';
}

/** Copies of the school's logos sized for the sheet (logos/schedule-sheet), so an export stays small. */
const SHEET = path.join(process.cwd(), 'logos', 'schedule-sheet');
export const SCHEDULE_IMAGES = {
    secondaryCrest: path.join(SHEET, 'secondary-crest.png'),
    cambridgeSchoolCrest: path.join(SHEET, 'cambridge-school-crest.png'),
    aLevelCrest: path.join(SHEET, 'a-level-crest.png'),
    oLevelCrest: path.join(SHEET, 'o-level-crest.png'),
    motto: path.join(SHEET, 'each-one-teach-one.png'),
    cambridge: path.join(SHEET, 'cambridge.png'),
    /** The Academic Directress's signature, as on every schedule the school sends. */
    signature: path.join(SHEET, 'signature.png'),
};

const SECONDARY_SCHOOL = 'THE AMERICAN FOUNDATION SECONDARY SCHOOL';
const A_LEVEL_SCHOOL = 'THE AMERICAN FOUNDATION SCHOOL FOR A LEVEL STUDIES';

export interface FontSpec {
    name: string;
    size: number;
    bold?: boolean;
    underline?: boolean;
    italic?: boolean;
}

export interface LayoutSpec {
    key: ScheduleLayout;
    school: string;
    /** The school's name under the signatory. */
    signatureSchool: string;
    leftLogo: string;
    /** Width and height in pixels on the sheet. */
    leftLogoSize: [number, number];
    rightLogo: string;
    rightLogoSize: [number, number];
    letterFont: FontSpec;
    refFont: FontSpec;
    schoolFont: FontSpec;
    titleFont: FontSpec;
    lineFont: FontSpec;
    sessionFont: FontSpec;
    /** "SESSION : 2026 - 2027" */
    sessionText: (years: [string, string]) => string;
    /** Print the campus ("CAMPUS - II") under the session. */
    campusHeading: boolean;
    /** Print "CLASSES IX & X" when the schedule has no line of its own. */
    deriveSegment: boolean;
    /** Separator in paper dates: "11 - 12 - 2026" or "11 – 12 – 2026". */
    dateSep: string;
    serial: boolean;
    /** A timing column beside every class (O Levels). */
    timingPerClass: boolean;
    /** A "LEVELS" band over the class columns. */
    levelsBand: boolean;
    /** Grey fill on the class headings. */
    greyHeader: boolean;
    headerFont: FontSpec;
    bodyFont: FontSpec;
    headerHeight: number;
    bodyHeight: number;
    /** Column widths, in characters. */
    widths: { serial: number; day: number; date: number; time: number; class: (n: number) => number };
    classLabel: (description: string) => string;
    noteHeading: string;
    noteHeadingFont: FontSpec;
    bullet: string;
    noteFont: FontSpec;
    regards: boolean;
    signatoryFont: FontSpec;
    /** Footer lines, centred under the signature. */
    footer: (f: { campusLabel: string; segmentLine: string | null; address: string }) => string[];
    footerFont: FontSpec;
    landscape: (classCount: number) => boolean;
}

const arial = (size: number, more: Partial<FontSpec> = {}): FontSpec => ({ name: 'Arial', size, bold: true, ...more });
const times = (size: number, more: Partial<FontSpec> = {}): FontSpec => ({ name: 'Times New Roman', size, bold: true, ...more });
const template = (size: number): FontSpec => ({ name: 'TemplateCapsSSK', size, bold: true });

/** "SR-I" → "SR - I" (as on the Senior sheet). */
const spacedDash = (d: string) => d.toUpperCase().replace(/\s*-\s*/, ' - ');
/** "JR-I" → "JR. I" (as on the Junior sheet). */
const dotted = (d: string) => d.toUpperCase().replace(/^JR\s*-\s*/, 'JR. ');

export const LAYOUTS: Record<ScheduleLayout, LayoutSpec> = {
    SECONDARY: {
        key: 'SECONDARY',
        school: SECONDARY_SCHOOL,
        signatureSchool: 'The American Foundation Secondary School.',
        leftLogo: SCHEDULE_IMAGES.secondaryCrest,
        leftLogoSize: [80, 77],
        rightLogo: SCHEDULE_IMAGES.motto,
        rightLogoSize: [178, 51],
        letterFont: arial(9),
        refFont: times(10),
        schoolFont: template(20),
        titleFont: times(15),
        lineFont: times(14),
        sessionFont: times(14),
        sessionText: ([a, b]) => `SESSION : ${a} - ${b}`,
        campusHeading: true,
        deriveSegment: true,
        dateSep: ' - ',
        serial: false,
        timingPerClass: false,
        levelsBand: false,
        greyHeader: false,
        headerFont: arial(10),
        bodyFont: arial(10),
        headerHeight: 21,
        bodyHeight: 18,
        // Prelim (2 classes): 18 / 22 / 22 / 36; Final Midterm (3): 16.7 / 17.3 / 23.9 / 25.8.
        widths: { serial: 0, day: 17, date: 19, time: 23, class: (n) => (n <= 2 ? 36 : n === 3 ? 26 : n === 4 ? 21 : 17) },
        classLabel: (d) => d.toUpperCase(),
        noteHeading: 'NOTE:',
        noteHeadingFont: arial(11, { underline: true }),
        bullet: '●   ',
        noteFont: arial(8),
        regards: false,
        signatoryFont: arial(9),
        footer: ({ campusLabel, address }) => [
            `${campusLabel} : SECONDARY SEGMENT`,
            address,
            'E - mail : american@cyber.net.pk   info@tafs.edu.pk',
            'Website : www.tafs.edu.pk',
        ],
        footerFont: arial(8),
        landscape: () => false,
    },
    O_LEVEL: {
        key: 'O_LEVEL',
        school: A_LEVEL_SCHOOL,
        signatureSchool: 'The American Foundation School for A Level Studies.',
        leftLogo: SCHEDULE_IMAGES.cambridgeSchoolCrest,
        leftLogoSize: [84, 81],
        rightLogo: SCHEDULE_IMAGES.cambridge,
        rightLogoSize: [176, 40],
        letterFont: times(8),
        refFont: times(8),
        schoolFont: template(18),
        titleFont: times(15),
        lineFont: times(14),
        sessionFont: times(16),
        sessionText: ([a, b]) => `SESSION ${a} - ${b}`,
        campusHeading: false,
        deriveSegment: false,
        dateSep: ' - ',
        serial: true,
        timingPerClass: true,
        levelsBand: true,
        greyHeader: true,
        headerFont: times(11),
        bodyFont: times(8),
        headerHeight: 30,
        bodyHeight: 24,
        widths: { serial: 6, day: 12.3, date: 10.4, time: 18.3, class: () => 19.7 },
        classLabel: (d) => d.toUpperCase(),
        noteHeading: 'NOTE :',
        noteHeadingFont: arial(10, { underline: true, italic: true }),
        bullet: '·    ',
        noteFont: times(7.5),
        regards: true,
        signatoryFont: times(8),
        footer: ({ address }) => [
            'TAFSAL : O & A LEVEL SEGMENT',
            address,
            'E - mail : american@cyber.net.pk         info@tafs.edu.pk       Website : www.tafs.edu.pk',
        ],
        footerFont: arial(7),
        landscape: () => true,
    },
    SENIOR: {
        key: 'SENIOR',
        school: A_LEVEL_SCHOOL,
        signatureSchool: 'The American Foundation School for A Level Studies.',
        leftLogo: SCHEDULE_IMAGES.aLevelCrest,
        leftLogoSize: [84, 81],
        rightLogo: SCHEDULE_IMAGES.cambridge,
        rightLogoSize: [176, 40],
        letterFont: times(11),
        refFont: times(11),
        schoolFont: template(20),
        titleFont: times(15),
        lineFont: times(15),
        sessionFont: times(16),
        sessionText: ([a, b]) => `SESSION : ${a} – ${b}`,
        campusHeading: false,
        deriveSegment: true,
        dateSep: ' – ',
        serial: true,
        timingPerClass: false,
        levelsBand: false,
        greyHeader: true,
        headerFont: times(12),
        bodyFont: times(9),
        headerHeight: 32,
        bodyHeight: 18,
        widths: { serial: 4.5, day: 14, date: 14, time: 17, class: (n) => (n <= 3 ? 24 : 19) },
        classLabel: spacedDash,
        noteHeading: 'NOTE :',
        noteHeadingFont: arial(10, { underline: true }),
        bullet: '•  ',
        noteFont: times(8),
        regards: true,
        signatoryFont: times(9),
        footer: ({ campusLabel, segmentLine, address }) => [
            `${campusLabel} : ${(segmentLine || 'SENIOR CAMBRIDGE').toUpperCase()} SEGMENT`,
            address,
            'E-mail : american@cyber.net.pk    info@tafs.edu.pk Website : www.tafs.edu.pk',
        ],
        footerFont: times(9),
        landscape: () => true,
    },
    JUNIOR: {
        key: 'JUNIOR',
        school: A_LEVEL_SCHOOL,
        signatureSchool: 'The American Foundation School for A Level Studies.',
        leftLogo: SCHEDULE_IMAGES.oLevelCrest,
        leftLogoSize: [84, 81],
        rightLogo: SCHEDULE_IMAGES.cambridge,
        rightLogoSize: [176, 40],
        letterFont: times(10),
        refFont: times(10),
        schoolFont: template(20),
        titleFont: times(14),
        lineFont: times(14),
        sessionFont: times(14),
        sessionText: ([a, b]) => `SESSION : ${a} – ${b}`,
        campusHeading: false,
        deriveSegment: true,
        dateSep: ' – ',
        serial: true,
        timingPerClass: false,
        levelsBand: true,
        greyHeader: true,
        headerFont: arial(10),
        bodyFont: times(8),
        headerHeight: 20,
        bodyHeight: 30,
        widths: { serial: 4.5, day: 11.5, date: 11.5, time: 18, class: () => 19 },
        classLabel: dotted,
        noteHeading: 'NOTE:',
        noteHeadingFont: arial(9, { underline: true }),
        bullet: '•  ',
        noteFont: times(8),
        regards: false,
        signatoryFont: times(9),
        footer: () => [
            'GULISTAN -E- JAUHAR NETWORK  |  NORTH NAZIMABAD NETWORK  |  SCHEME 33 NETWORK',
            'E - mail : american@cyber.net.pk    info@tafs.edu.pk  Website : www.tafs.edu.pk',
        ],
        footerFont: times(9),
        landscape: () => true,
    },
};

/**
 * How the school names a campus on its sheets. Only Gulistan-e-Johar is known
 * ("CAMPUS - II" on every sheet sent); the others print their own name.
 */
/** The school's own name for a campus on its sheets. The address is never hard-coded: it is the campus record's. */
const CAMPUS_LABELS: Record<string, { label: string }> = {
    GEJ: { label: 'CAMPUS - II' },
};

export function campusOnSheet(campus: { campus_code: string | null; campus_name: string; address: string | null }) {
    const known =
        CAMPUS_LABELS[campus.campus_code?.toUpperCase() ?? ''] ??
        (/gulistan|johar|jauhar/i.test(campus.campus_name) ? CAMPUS_LABELS.GEJ : undefined);
    return {
        label: known?.label ?? campus.campus_name.toUpperCase(),
        // TAFSD-528: the address as entered on the campus in the system (Setup → Campuses).
        address: campus.address?.trim().toUpperCase() ?? '',
    };
}

/** A preset's paper row: no date, a subject per class, and a class's own time where it differs. */
export interface PresetRow {
    time: string;
    cells: Record<string, string>;
    times?: Record<string, string>;
}

/** A preset's stored rows, cleaned: strings only, blank cells dropped. */
export function presetRows(value: unknown): PresetRow[] {
    if (!Array.isArray(value)) return [];
    const strings = (o: unknown) =>
        Object.fromEntries(
            Object.entries(o && typeof o === 'object' ? (o as Record<string, unknown>) : {})
                .filter(([k, v]) => /^\d+$/.test(k) && typeof v === 'string' && v.trim())
                .map(([k, v]) => [k, (v as string).trim()]),
        );
    return value
        .filter((r) => r && typeof r === 'object')
        .map((r: Record<string, unknown>) => {
            const times = strings(r.times);
            return {
                time: typeof r.time === 'string' ? r.time.trim() : '',
                cells: strings(r.cells),
                ...(Object.keys(times).length ? { times } : {}),
            };
        });
}
