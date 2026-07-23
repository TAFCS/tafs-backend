import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import dotenv from 'dotenv';

dotenv.config();

let dbUrl = process.env.DATABASE_URL || '';
if (!dbUrl.includes('connection_limit')) {
    dbUrl += (dbUrl.includes('?') ? '&' : '?') + 'connection_limit=1';
}

const prisma = new PrismaClient({
    datasources: {
        db: { url: dbUrl }
    }
});

interface CSVRecord {
    'Sheet Name'?: string;
    'S. #'?: string;
    'REG. #'?: string;
    'C.C. #'?: string;
    'G.R. #'?: string;
    'DATE OF BIRTH'?: string;
    "STUDENT'S NAME"?: string;
    "FATHER'S NAME"?: string;
    [key: string]: any;
}

/**
 * Parses DD.MM.YYYY format into Date object.
 * Returns null for invalid/blank formats.
 */
function parseDDMMYYYY(raw: string | undefined): Date | null {
    if (!raw) return null;
    const cleaned = raw.trim();
    if (!cleaned || cleaned.includes('----') || cleaned.includes('--')) return null;

    // Support separators: ., /, -
    const parts = cleaned.split(/[.\/-]/);
    if (parts.length !== 3) return null;

    const day = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10);
    const year = parseInt(parts[2], 10);

    if (isNaN(day) || isNaN(month) || isNaN(year)) return null;
    if (month < 1 || month > 12) return null;
    if (day < 1 || day > 31) return null;
    if (year < 1990 || year > 2026) return null;

    const date = new Date(Date.UTC(year, month - 1, day));
    return isNaN(date.getTime()) ? null : date;
}

function formatDateISO(date: Date | null | undefined): string {
    if (!date) return 'NULL';
    return date.toISOString().split('T')[0];
}

async function runDryRun() {
    const csvPath = path.join(__dirname, '../students-data-23-kul-jhr/STUDENT PROFILE 2026-2027 JULY 23.csv');

    if (!fs.existsSync(csvPath)) {
        console.error(`CSV file not found at ${csvPath}`);
        process.exit(1);
    }

    const fileContent = fs.readFileSync(csvPath, 'utf8');
    const records: CSVRecord[] = parse(fileContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true
    });

    console.log(`Loaded ${records.length} total records from CSV.`);
    console.log(`Running 100-row DRY RUN...\n`);

    // Fetch DB index of all students to optimize lookups
    const allDbStudents = await prisma.students.findMany({
        select: {
            cc: true,
            gr_number: true,
            full_name: true,
            dob: true
        }
    });

    const ccMap = new Map<number, typeof allDbStudents[0]>();
    const grMap = new Map<string, typeof allDbStudents[0]>();
    const nameMap = new Map<string, typeof allDbStudents[0]>();

    for (const s of allDbStudents) {
        if (s.cc) ccMap.set(s.cc, s);
        if (s.gr_number) grMap.set(s.gr_number.trim(), s);
        if (s.full_name) nameMap.set(s.full_name.trim().toUpperCase(), s);
    }

    console.log(`DB Cache loaded: ${allDbStudents.length} students in database.\n`);

    const limit = 100;
    const slice = records.slice(0, limit);

    let matchByCC = 0;
    let matchByGR = 0;
    let matchByName = 0;
    let notFoundCount = 0;
    let dobValidCount = 0;
    let dobInvalidCount = 0;
    let dobChangeCount = 0;
    let dobUnchangedCount = 0;

    const dryRunResults: Array<{
        rowNum: number;
        sheet: string;
        csvCC: string;
        csvGR: string;
        csvName: string;
        csvDOB: string;
        parsedDOB: string;
        matchType: string;
        dbCC: string;
        dbDOBBefore: string;
        proposedDOBAfter: string;
        status: string;
    }> = [];

    for (let i = 0; i < slice.length; i++) {
        const row = slice[i];
        const rowNum = i + 1;
        const sheet = row['Sheet Name'] || '';
        const csvCCRaw = row['C.C. #'] || '';
        const csvGRRaw = row['G.R. #'] || '';
        const csvName = (row["STUDENT'S NAME"] || '').trim();
        const csvDOBRaw = row['DATE OF BIRTH'] || '';

        const parsedDate = parseDDMMYYYY(csvDOBRaw);
        const parsedDOBStr = parsedDate ? formatDateISO(parsedDate) : 'INVALID/EMPTY';

        if (parsedDate) {
            dobValidCount++;
        } else {
            dobInvalidCount++;
        }

        // Match logic
        let matchedStudent: typeof allDbStudents[0] | undefined = undefined;
        let matchType = 'NONE';

        const parsedCC = parseInt(csvCCRaw, 10);
        if (!isNaN(parsedCC) && ccMap.has(parsedCC)) {
            matchedStudent = ccMap.get(parsedCC);
            matchType = 'CC';
            matchByCC++;
        } else if (csvGRRaw && grMap.has(csvGRRaw.trim())) {
            matchedStudent = grMap.get(csvGRRaw.trim());
            matchType = 'GR';
            matchByGR++;
        } else if (csvName && nameMap.has(csvName.toUpperCase())) {
            matchedStudent = nameMap.get(csvName.toUpperCase());
            matchType = 'NAME';
            matchByName++;
        } else {
            notFoundCount++;
        }

        let status = '';
        let dbDOBBeforeStr = 'N/A';
        let proposedDOBAfterStr = 'N/A';

        if (!matchedStudent) {
            status = 'NOT_FOUND_IN_DB';
        } else if (!parsedDate) {
            dbDOBBeforeStr = formatDateISO(matchedStudent.dob);
            status = 'INVALID_DOB_SKIPPED';
        } else {
            dbDOBBeforeStr = formatDateISO(matchedStudent.dob);
            proposedDOBAfterStr = parsedDOBStr;

            if (dbDOBBeforeStr === proposedDOBAfterStr) {
                status = 'UNCHANGED';
                dobUnchangedCount++;
            } else {
                status = 'WOULD_UPDATE';
                dobChangeCount++;
            }
        }

        dryRunResults.push({
            rowNum,
            sheet,
            csvCC: csvCCRaw,
            csvGR: csvGRRaw,
            csvName,
            csvDOB: csvDOBRaw,
            parsedDOB: parsedDOBStr,
            matchType,
            dbCC: matchedStudent ? String(matchedStudent.cc) : 'N/A',
            dbDOBBefore: dbDOBBeforeStr,
            proposedDOBAfter: proposedDOBAfterStr,
            status
        });
    }

    console.log('=' .repeat(120));
    console.log(`DRY RUN RESULTS TABLE (First 100 Rows)`);
    console.log('=' .repeat(120));
    console.log(
        '#'.padEnd(4) +
        'Sheet'.padEnd(10) +
        'Name'.padEnd(25) +
        'CSV DOB'.padEnd(14) +
        'Parsed DOB'.padEnd(12) +
        'Match'.padEnd(8) +
        'DB DOB Before'.padEnd(14) +
        'New DOB After'.padEnd(14) +
        'Action'
    );
    console.log('-'.repeat(120));

    for (const res of dryRunResults) {
        console.log(
            String(res.rowNum).padEnd(4) +
            res.sheet.slice(0, 9).padEnd(10) +
            res.csvName.slice(0, 24).padEnd(25) +
            res.csvDOB.padEnd(14) +
            res.parsedDOB.padEnd(12) +
            res.matchType.padEnd(8) +
            res.dbDOBBefore.padEnd(14) +
            res.proposedDOBAfter.padEnd(14) +
            res.status
        );
    }

    console.log('=' .repeat(120));
    console.log('SUMMARY METRICS FOR 100-ROW DRY RUN:');
    console.log(`- Rows Tested:              100`);
    console.log(`- Matched by CC:            ${matchByCC}`);
    console.log(`- Matched by GR #:          ${matchByGR}`);
    console.log(`- Matched by Name:          ${matchByName}`);
    console.log(`- Not Found in DB:          ${notFoundCount}`);
    console.log(`- Valid DOB in CSV:         ${dobValidCount}`);
    console.log(`- Invalid/Blank DOB:        ${dobInvalidCount}`);
    console.log(`- Would Update DB DOB:      ${dobChangeCount}`);
    console.log(`- DOB Already Identical:    ${dobUnchangedCount}`);
    console.log('=' .repeat(120));
}

runDryRun()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
