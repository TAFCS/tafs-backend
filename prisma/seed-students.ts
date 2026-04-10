/**
 * Seed script: inserts students from student_profiles_merged CSV
 * into the `students` table.
 *
 * Mappings used:
 *   classes   : class_code -> id  (from classes_rows.csv)
 *   sections  : description -> id (A=1, B=2, C=3, D=4)
 *   houses    : house_name  -> id (IQBAL=1, JINNAH=2, LIAQUAT=3, SIR SYED=4)
 *   campus_id : 1 (hard-coded per CSV column)
 *
 * Rules:
 *   - If section letter is absent in "class & section", default to section A (id=1)
 *   - dob / doa: skip if blank or clearly invalid (e.g. year "----")
 *   - cc is used as the primary key (@id) in the students table
 *   - gr_number stored as-is
 *   - status defaults to ENROLLED
 */


import { PrismaClient, student_status } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';

const prisma = new PrismaClient();

// ── Reference tables ──────────────────────────────────────────────────────────

/** Maps the class label from the CSV to a classes.id */
const CLASS_CODE_TO_ID: Record<string, number> = {
    PN: 1,
    NUR: 2,
    KG: 3,
    'JR. I': 4,
    'JR. II': 5,
    'JR. III': 6,
    'JR. IV': 7,
    'JR.IV': 7,   // alternate spelling present in CSV
    'JR. V': 8,
    'SR. I': 9,
    'SR. II': 10,
    'SR. III': 11,
    'O-I': 12,
    'O-II': 13,
    'O-III': 14,
    VI: 15,
    VII: 16,
    VIII: 17,
    IX: 18,
    X: 19,
    AS: 21,
    'AS-A': 21, // some rows include the section in the class column
    'AS-C': 21,
    A2: 22,
    'A2-A': 22,
    'A2-C': 22,
};

/** Maps section letter to sections.id */
const SECTION_LETTER_TO_ID: Record<string, number> = {
    A: 1,
    B: 2,
    C: 3,
    D: 4,
};

/** Maps house name to houses.id */
const HOUSE_NAME_TO_ID: Record<string, number> = {
    'IQBAL HOUSE': 1,
    'JINNAH HOUSE': 2,
    'LIAQUAT HOUSE': 3,
    'SIR SYED HOUSE': 4,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parses a date string in "DD.MM.YYYY" format.
 * Returns null if the string is empty or contains invalid parts.
 */
function parseDate(raw: string): Date | null {
    const s = raw.trim();
    if (!s) return null;
    // Reject strings with placeholder year like "09.09.----"
    if (s.includes('----') || s.includes('--')) return null;
    const parts = s.split('.');
    if (parts.length !== 3) return null;
    const [day, month, year] = parts.map((p) => parseInt(p, 10));
    if (isNaN(day) || isNaN(month) || isNaN(year)) return null;
    if (year < 1900 || year > 2100) return null;
    const d = new Date(Date.UTC(year, month - 1, day));
    return isNaN(d.getTime()) ? null : d;
}

/**
 * Parses "class & section" into { classId, sectionId }.
 *
 * Examples:
 *   "PN A"     -> class=PN,     section=A
 *   "KG"       -> class=KG,     section=A (default)
 *   "JR. I B"  -> class=JR. I,  section=B
 *   "JR. IV"   -> class=JR. IV, section=A (default)
 *   "A2-A"     -> class=A2,     section=A
 *   "IX B"     -> class=IX,     section=B
 *   "VI"       -> class=VI,     section=A (default)
 */
function parseClassSection(raw: string): {
    classId: number | null;
    sectionId: number;
} {
    const s = raw.trim();

    // Patterns like "A2-A", "A2-C", "AS-A", "AS-C"
    const asA2Match = s.match(/^(A2|AS)-([A-D])$/);
    if (asA2Match) {
        const classId = CLASS_CODE_TO_ID[asA2Match[1]] ?? null;
        const sectionId = SECTION_LETTER_TO_ID[asA2Match[2]] ?? 1;
        return { classId, sectionId };
    }

    // Try to peel a trailing single uppercase letter (section) off the string
    const trailingSectionMatch = s.match(/^(.+)\s+([A-D])$/);
    if (trailingSectionMatch) {
        const classLabel = trailingSectionMatch[1].trim();
        const sectionLetter = trailingSectionMatch[2];
        const classId = CLASS_CODE_TO_ID[classLabel] ?? null;
        const sectionId = SECTION_LETTER_TO_ID[sectionLetter] ?? 1;
        return { classId, sectionId };
    }

    // No section suffix – the whole string is the class, default to section A
    const classId = CLASS_CODE_TO_ID[s] ?? null;
    return { classId, sectionId: 1 };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    const csvPath = path.resolve(
        '/Users/macbook/Downloads/student_profiles_merged - student_profiles_merged.csv.csv',
    );

    if (!fs.existsSync(csvPath)) {
        throw new Error(`CSV not found at: ${csvPath}`);
    }

    const raw = fs.readFileSync(csvPath, 'utf-8');
    const records: Array<Record<string, string>> = parse(raw, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
    });

    console.log(`Parsed ${records.length} rows from CSV`);

    let inserted = 0;
    let skipped = 0;
    let errors = 0;

    for (const row of records) {
        const cc = parseInt(row['cc'], 10);
        const gr = row['gr']?.trim() || null;
        const fullName = row['full_name']?.trim();
        const houseRaw = row['house']?.trim().toUpperCase();
        const classSection = row['class & section']?.trim();
        const campusId = parseInt(row['campus_id'], 10) || 1;

        if (!cc || isNaN(cc)) {
            console.warn(`  SKIP – invalid cc: ${JSON.stringify(row)}`);
            skipped++;
            continue;
        }

        if (!fullName) {
            console.warn(`  SKIP – missing full_name for cc=${cc}`);
            skipped++;
            continue;
        }

        const doa = parseDate(row['doa'] ?? '');
        const dob = parseDate(row['dob'] ?? '');
        const houseId = HOUSE_NAME_TO_ID[houseRaw] ?? null;
        const { classId, sectionId } = parseClassSection(classSection ?? '');

        if (!classId) {
            console.warn(
                `  WARN – could not resolve class for cc=${cc}, class&section="${classSection}"`,
            );
        }

        try {
            await prisma.students.upsert({
                where: { cc },
                update: {
                    gr_number: gr,
                    full_name: fullName,
                    dob,
                    doa,
                    house_id: houseId,
                    class_id: classId,
                    section_id: sectionId,
                    campus_id: campusId,
                },
                create: {
                    cc,
                    gr_number: gr,
                    full_name: fullName,
                    dob,
                    doa,
                    house_id: houseId,
                    class_id: classId,
                    section_id: sectionId,
                    campus_id: campusId,
                    status: student_status.ENROLLED,
                },
            });
            inserted++;

            if (inserted % 100 === 0) {
                console.log(`  ...upserted ${inserted} students so far`);
            }
        } catch (e) {
            console.error(`  ERROR upserting cc=${cc} (${fullName}):`, e);
            errors++;
        }
    }

    console.log(`\nDone. Upserted: ${inserted}, Skipped: ${skipped}, Errors: ${errors}`);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
