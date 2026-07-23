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

function parseDDMMYYYY(raw: string | undefined): Date | null {
    if (!raw) return null;
    const cleaned = raw.trim();
    if (!cleaned || cleaned.includes('----') || cleaned.includes('--')) return null;

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

function normalizeName(str: string): string {
    return str.toUpperCase().replace(/[^A-Z]/g, '');
}

function namesAreSimilar(name1: string, name2: string): boolean {
    const n1 = normalizeName(name1);
    const n2 = normalizeName(name2);
    if (!n1 || !n2) return false;
    return n1.includes(n2) || n2.includes(n1) || n1.slice(0, 5) === n2.slice(0, 5);
}

async function runDryRunMatching() {
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

    // Fetch DB index of all students
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
        if (s.full_name) nameMap.set(normalizeName(s.full_name), s);
    }

    const matchedResults: Array<{
        matchIndex: number;
        csvRow: number;
        sheet: string;
        csvName: string;
        dbCC: number;
        dbName: string;
        matchType: string;
        csvDOB: string;
        parsedDOB: string;
        dbDOBBefore: string;
        status: string;
    }> = [];

    let count = 0;
    let wouldUpdateCount = 0;
    let unchangedCount = 0;
    let invalidDOBCount = 0;

    for (let i = 0; i < records.length; i++) {
        if (count >= 100) break;

        const row = records[i];
        const csvRow = i + 1;
        const sheet = row['Sheet Name'] || '';
        const csvCCRaw = (row['C.C. #'] || '').trim();
        const csvGRRaw = (row['G.R. #'] || '').trim();
        const csvName = (row["STUDENT'S NAME"] || '').trim();
        const csvDOBRaw = (row['DATE OF BIRTH'] || '').trim();

        let matchedStudent: typeof allDbStudents[0] | undefined = undefined;
        let matchType = 'NONE';

        const parsedCC = parseInt(csvCCRaw, 10);
        
        // 1. Try matching by CC first, verifying name similarity
        if (!isNaN(parsedCC) && ccMap.has(parsedCC)) {
            const candidate = ccMap.get(parsedCC)!;
            if (namesAreSimilar(csvName, candidate.full_name)) {
                matchedStudent = candidate;
                matchType = 'CC';
            }
        }

        // 2. If CC match failed or name collided, try GR #
        if (!matchedStudent && csvGRRaw && grMap.has(csvGRRaw)) {
            matchedStudent = grMap.get(csvGRRaw);
            matchType = 'GR';
        }

        // 3. Fallback to Name match
        if (!matchedStudent && csvName && nameMap.has(normalizeName(csvName))) {
            matchedStudent = nameMap.get(normalizeName(csvName));
            matchType = 'NAME';
        }

        if (!matchedStudent) continue; // Only process matching students

        count++;
        const parsedDate = parseDDMMYYYY(csvDOBRaw);
        const parsedDOBStr = parsedDate ? formatDateISO(parsedDate) : 'INVALID';
        const dbDOBBeforeStr = formatDateISO(matchedStudent.dob);

        let status = '';
        if (!parsedDate) {
            status = 'INVALID_DOB_SKIPPED';
            invalidDOBCount++;
        } else if (dbDOBBeforeStr === parsedDOBStr) {
            status = 'UNCHANGED';
            unchangedCount++;
        } else {
            status = 'WOULD_UPDATE';
            wouldUpdateCount++;
        }

        matchedResults.push({
            matchIndex: count,
            csvRow,
            sheet,
            csvName,
            dbCC: matchedStudent.cc,
            dbName: matchedStudent.full_name,
            matchType,
            csvDOB: csvDOBRaw,
            parsedDOB: parsedDOBStr,
            dbDOBBefore: dbDOBBeforeStr,
            status
        });
    }

    console.log('=' .repeat(130));
    console.log(`DRY RUN ON 100 MATCHING STUDENTS`);
    console.log('=' .repeat(130));
    console.log(
        '#'.padEnd(5) +
        'Row'.padEnd(6) +
        'Sheet'.padEnd(9) +
        'DB CC'.padEnd(8) +
        'CSV Student Name'.padEnd(24) +
        'Match'.padEnd(7) +
        'CSV DOB'.padEnd(13) +
        'Current DB DOB'.padEnd(15) +
        'Proposed DOB'.padEnd(14) +
        'Action'
    );
    console.log('-'.repeat(130));

    for (const r of matchedResults) {
        console.log(
            String(r.matchIndex).padEnd(5) +
            String(r.csvRow).padEnd(6) +
            r.sheet.slice(0, 8).padEnd(9) +
            String(r.dbCC).padEnd(8) +
            r.csvName.slice(0, 23).padEnd(24) +
            r.matchType.padEnd(7) +
            r.csvDOB.padEnd(13) +
            r.dbDOBBefore.padEnd(15) +
            r.parsedDOB.padEnd(14) +
            r.status
        );
    }

    console.log('=' .repeat(130));
    console.log('DRY RUN SUMMARY (100 MATCHING STUDENTS):');
    console.log(`- Total Matched Students Tested: ${count}`);
    console.log(`- Matched by CC #:               ${matchedResults.filter(r => r.matchType === 'CC').length}`);
    console.log(`- Matched by GR #:               ${matchedResults.filter(r => r.matchType === 'GR').length}`);
    console.log(`- Matched by Name:               ${matchedResults.filter(r => r.matchType === 'NAME').length}`);
    console.log(`- Records WOULD BE UPDATED:      ${wouldUpdateCount}`);
    console.log(`- DOB Already Identical:         ${unchangedCount}`);
    console.log(`- Invalid/Blank DOB Skipped:     ${invalidDOBCount}`);
    console.log('=' .repeat(130));
}

runDryRunMatching()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
