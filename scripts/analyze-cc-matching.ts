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

async function analyzeCCMatching() {
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

    console.log(`Analyzing CC matching for all ${records.length} records in CSV...\n`);

    // Fetch all students from DB
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

    console.log(`DB Total Students: ${allDbStudents.length}`);

    let totalRows = records.length;
    let ccPresentInCSV = 0;
    let ccMissingInCSV = 0;

    let directCCMatch = 0;
    let ccMismatchName = 0;
    let ccNotFoundButMatchedByGR = 0;
    let ccNotFoundButMatchedByName = 0;
    let completelyUnmatched = 0;

    const nameDiscrepancies: Array<{
        csvRow: number;
        sheet: string;
        csvCC: number;
        csvName: string;
        dbName: string;
        dbGR: string;
    }> = [];

    const missingCCMatches: Array<{
        csvRow: number;
        sheet: string;
        csvGR: string;
        csvName: string;
        matchedBy: string;
        matchedDBCC: number;
        dbName: string;
    }> = [];

    const unmatchedRows: Array<{
        csvRow: number;
        sheet: string;
        csvCC: string;
        csvGR: string;
        csvName: string;
    }> = [];

    for (let i = 0; i < records.length; i++) {
        const row = records[i];
        const csvRow = i + 1;
        const sheet = row['Sheet Name'] || '';
        const csvCCRaw = (row['C.C. #'] || '').trim();
        const csvGRRaw = (row['G.R. #'] || '').trim();
        const csvName = (row["STUDENT'S NAME"] || '').trim();

        const csvCC = csvCCRaw ? parseInt(csvCCRaw, 10) : NaN;

        if (!isNaN(csvCC)) {
            ccPresentInCSV++;

            if (ccMap.has(csvCC)) {
                directCCMatch++;
                const dbStudent = ccMap.get(csvCC)!;
                
                // Compare student names to ensure the CC actually belongs to the same student
                const normCSVName = csvName.toUpperCase().replace(/[^A-Z]/g, '');
                const normDBName = (dbStudent.full_name || '').toUpperCase().replace(/[^A-Z]/g, '');

                if (normCSVName && normDBName && !normDBName.includes(normCSVName) && !normCSVName.includes(normDBName)) {
                    ccMismatchName++;
                    nameDiscrepancies.push({
                        csvRow,
                        sheet,
                        csvCC,
                        csvName,
                        dbName: dbStudent.full_name || '',
                        dbGR: dbStudent.gr_number || ''
                    });
                }
            } else {
                // CC given in CSV but not found in DB by CC integer
                if (csvGRRaw && grMap.has(csvGRRaw)) {
                    ccNotFoundButMatchedByGR++;
                    const dbStudent = grMap.get(csvGRRaw)!;
                    missingCCMatches.push({
                        csvRow,
                        sheet,
                        csvGR: csvGRRaw,
                        csvName,
                        matchedBy: 'GR #',
                        matchedDBCC: dbStudent.cc,
                        dbName: dbStudent.full_name || ''
                    });
                } else if (csvName && nameMap.has(csvName.toUpperCase())) {
                    ccNotFoundButMatchedByName++;
                    const dbStudent = nameMap.get(csvName.toUpperCase())!;
                    missingCCMatches.push({
                        csvRow,
                        sheet,
                        csvGR: csvGRRaw,
                        csvName,
                        matchedBy: 'NAME',
                        matchedDBCC: dbStudent.cc,
                        dbName: dbStudent.full_name || ''
                    });
                } else {
                    completelyUnmatched++;
                    unmatchedRows.push({
                        csvRow,
                        sheet,
                        csvCC: csvCCRaw,
                        csvGR: csvGRRaw,
                        csvName
                    });
                }
            }
        } else {
            ccMissingInCSV++;
            if (csvGRRaw && grMap.has(csvGRRaw)) {
                ccNotFoundButMatchedByGR++;
                const dbStudent = grMap.get(csvGRRaw)!;
                missingCCMatches.push({
                    csvRow,
                    sheet,
                    csvGR: csvGRRaw,
                    csvName,
                    matchedBy: 'GR #',
                    matchedDBCC: dbStudent.cc,
                    dbName: dbStudent.full_name || ''
                });
            } else if (csvName && nameMap.has(csvName.toUpperCase())) {
                ccNotFoundButMatchedByName++;
                const dbStudent = nameMap.get(csvName.toUpperCase())!;
                missingCCMatches.push({
                    csvRow,
                    sheet,
                    csvGR: csvGRRaw,
                    csvName,
                    matchedBy: 'NAME',
                    matchedDBCC: dbStudent.cc,
                    dbName: dbStudent.full_name || ''
                });
            } else {
                completelyUnmatched++;
                unmatchedRows.push({
                    csvRow,
                    sheet,
                    csvCC: csvCCRaw,
                    csvGR: csvGRRaw,
                    csvName
                });
            }
        }
    }

    console.log('============================================================');
    console.log('CC MATCHING ANALYSIS BREAKDOWN');
    console.log('============================================================');
    console.log(`Total CSV Rows:                         ${totalRows}`);
    console.log(`Total DB Students:                      ${allDbStudents.length}`);
    console.log(`CSV Rows with C.C. #:                   ${ccPresentInCSV}`);
    console.log(`CSV Rows missing C.C. #:                ${ccMissingInCSV}`);
    console.log(`Direct C.C. # Matches in DB:            ${directCCMatch}`);
    console.log(`  └─ Name Discrepancies on CC Match:   ${ccMismatchName}`);
    console.log(`C.C. # Missing/Not Found but Matched by GR: ${ccNotFoundButMatchedByGR}`);
    console.log(`C.C. # Missing/Not Found but Matched by Name: ${ccNotFoundButMatchedByName}`);
    console.log(`Completely Unmatched Rows:              ${completelyUnmatched}`);
    console.log('============================================================\n');

    if (nameDiscrepancies.length > 0) {
        console.log(`--- Name Discrepancies on Direct CC Match (First 10) ---`);
        for (const d of nameDiscrepancies.slice(0, 10)) {
            console.log(`Row ${d.csvRow} [${d.sheet}] CC: ${d.csvCC} | CSV Name: "${d.csvName}" vs DB Name: "${d.dbName}" (DB GR: ${d.dbGR})`);
        }
        console.log();
    }

    if (missingCCMatches.length > 0) {
        console.log(`--- Rows Matched via GR/Name (Missing or Invalid CSV CC) (First 10) ---`);
        for (const m of missingCCMatches.slice(0, 10)) {
            console.log(`Row ${m.csvRow} [${m.sheet}] CSV Name: "${m.csvName}" (GR: ${m.csvGR}) -> Matched by ${m.matchedBy} -> Assigned DB CC: ${m.matchedDBCC} ("${m.dbName}")`);
        }
        console.log();
    }

    if (unmatchedRows.length > 0) {
        console.log(`--- Completely Unmatched Rows (First 10) ---`);
        for (const u of unmatchedRows.slice(0, 10)) {
            console.log(`Row ${u.csvRow} [${u.sheet}] CC: "${u.csvCC}" | GR: "${u.csvGR}" | Name: "${u.csvName}"`);
        }
        console.log();
    }
}

analyzeCCMatching()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
