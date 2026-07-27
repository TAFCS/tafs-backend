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

interface ReportRow {
    CSV_Row_Num: number;
    Sheet_Name: string;
    CSV_CC: string;
    CSV_GR: string;
    CSV_Student_Name: string;
    Matched_DB_CC: string;
    Matched_DB_Student_Name: string;
    Match_Method: string;
    CSV_Raw_DOB: string;
    Parsed_DOB: string;
    Old_DB_DOB: string;
    New_DB_DOB: string;
    Status: 'UPDATED' | 'UNCHANGED' | 'INVALID_DOB_SKIPPED' | 'NAME_MISMATCH_SKIPPED' | 'NOT_FOUND_IN_DB';
    Reason: string;
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

function exportToCSV(rows: ReportRow[]): string {
    const headers = [
        'CSV_Row_Num',
        'Sheet_Name',
        'CSV_CC',
        'CSV_GR',
        'CSV_Student_Name',
        'Matched_DB_CC',
        'Matched_DB_Student_Name',
        'Match_Method',
        'CSV_Raw_DOB',
        'Parsed_DOB',
        'Old_DB_DOB',
        'New_DB_DOB',
        'Status',
        'Reason'
    ];

    const lines = [headers.join(',')];
    for (const r of rows) {
        const line = headers.map(h => {
            const val = String((r as any)[h] || '');
            const escaped = val.replace(/"/g, '""');
            return `"${escaped}"`;
        }).join(',');
        lines.push(line);
    }
    return lines.join('\n');
}

async function processSingleFile(csvPath: string, fullReportPath: string, updatesOnlyReportPath: string) {
    if (!fs.existsSync(csvPath)) {
        console.error(`CSV file not found at ${csvPath}`);
        return;
    }

    const fileContent = fs.readFileSync(csvPath, 'utf8');
    const records: CSVRecord[] = parse(fileContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true
    });

    console.log(`\n============================================================`);
    console.log(`PROCESSING: ${path.basename(csvPath)} (${records.length} records)`);
    console.log(`============================================================`);

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

    const reportRows: ReportRow[] = [];

    let totalUpdated = 0;
    let totalUnchanged = 0;
    let totalInvalidDOB = 0;
    let totalNameMismatchSkipped = 0;
    let totalNotFound = 0;

    for (let i = 0; i < records.length; i++) {
        const row = records[i];
        const csvRowNum = i + 1;
        const sheetName = row['Sheet Name'] || '';
        const csvCCRaw = (row['C.C. #'] || '').trim();
        const csvGRRaw = (row['G.R. #'] || '').trim();
        const csvName = (row["STUDENT'S NAME"] || '').trim();
        const csvDOBRaw = (row['DATE OF BIRTH'] || '').trim();

        const parsedCC = parseInt(csvCCRaw, 10);
        let matchedStudent: typeof allDbStudents[0] | undefined = undefined;
        let matchMethod = 'NONE';
        let reason = '';

        if (!isNaN(parsedCC) && ccMap.has(parsedCC)) {
            const candidate = ccMap.get(parsedCC)!;
            if (namesAreSimilar(csvName, candidate.full_name)) {
                matchedStudent = candidate;
                matchMethod = 'CC';
            } else {
                reason = `CC ${parsedCC} matched DB student "${candidate.full_name}" but CSV name is "${csvName}". Skipping for safety.`;
            }
        }

        if (!matchedStudent && csvGRRaw && grMap.has(csvGRRaw)) {
            matchedStudent = grMap.get(csvGRRaw);
            matchMethod = 'GR';
            reason = 'Matched by G.R. #';
        }

        if (!matchedStudent && csvName && nameMap.has(normalizeName(csvName))) {
            matchedStudent = nameMap.get(normalizeName(csvName));
            matchMethod = 'NAME';
            reason = 'Matched by Student Name';
        }

        if (!matchedStudent) {
            totalNotFound++;
            reportRows.push({
                CSV_Row_Num: csvRowNum,
                Sheet_Name: sheetName,
                CSV_CC: csvCCRaw,
                CSV_GR: csvGRRaw,
                CSV_Student_Name: csvName,
                Matched_DB_CC: 'N/A',
                Matched_DB_Student_Name: 'N/A',
                Match_Method: 'NONE',
                CSV_Raw_DOB: csvDOBRaw,
                Parsed_DOB: 'N/A',
                Old_DB_DOB: 'N/A',
                New_DB_DOB: 'N/A',
                Status: reason ? 'NAME_MISMATCH_SKIPPED' : 'NOT_FOUND_IN_DB',
                Reason: reason || 'Student not found in DB by CC, GR, or Name'
            });
            if (reason) totalNameMismatchSkipped++;
            continue;
        }

        const parsedDate = parseDDMMYYYY(csvDOBRaw);
        const parsedDOBStr = parsedDate ? formatDateISO(parsedDate) : 'INVALID';
        const oldDBDOBStr = formatDateISO(matchedStudent.dob);

        if (!parsedDate) {
            totalInvalidDOB++;
            reportRows.push({
                CSV_Row_Num: csvRowNum,
                Sheet_Name: sheetName,
                CSV_CC: csvCCRaw,
                CSV_GR: csvGRRaw,
                CSV_Student_Name: csvName,
                Matched_DB_CC: String(matchedStudent.cc),
                Matched_DB_Student_Name: matchedStudent.full_name,
                Match_Method: matchMethod,
                CSV_Raw_DOB: csvDOBRaw,
                Parsed_DOB: 'INVALID',
                Old_DB_DOB: oldDBDOBStr,
                New_DB_DOB: oldDBDOBStr,
                Status: 'INVALID_DOB_SKIPPED',
                Reason: `CSV DOB "${csvDOBRaw}" is invalid or blank.`
            });
            continue;
        }

        if (oldDBDOBStr === parsedDOBStr) {
            totalUnchanged++;
            reportRows.push({
                CSV_Row_Num: csvRowNum,
                Sheet_Name: sheetName,
                CSV_CC: csvCCRaw,
                CSV_GR: csvGRRaw,
                CSV_Student_Name: csvName,
                Matched_DB_CC: String(matchedStudent.cc),
                Matched_DB_Student_Name: matchedStudent.full_name,
                Match_Method: matchMethod,
                CSV_Raw_DOB: csvDOBRaw,
                Parsed_DOB: parsedDOBStr,
                Old_DB_DOB: oldDBDOBStr,
                New_DB_DOB: oldDBDOBStr,
                Status: 'UNCHANGED',
                Reason: 'DB DOB is already identical to parsed CSV DOB.'
            });
            continue;
        }

        // Perform Database Update
        try {
            await prisma.students.update({
                where: { cc: matchedStudent.cc },
                data: { dob: parsedDate }
            });

            totalUpdated++;
            reportRows.push({
                CSV_Row_Num: csvRowNum,
                Sheet_Name: sheetName,
                CSV_CC: csvCCRaw,
                CSV_GR: csvGRRaw,
                CSV_Student_Name: csvName,
                Matched_DB_CC: String(matchedStudent.cc),
                Matched_DB_Student_Name: matchedStudent.full_name,
                Match_Method: matchMethod,
                CSV_Raw_DOB: csvDOBRaw,
                Parsed_DOB: parsedDOBStr,
                Old_DB_DOB: oldDBDOBStr,
                New_DB_DOB: parsedDOBStr,
                Status: 'UPDATED',
                Reason: `DOB successfully updated from ${oldDBDOBStr} to ${parsedDOBStr}.`
            });
        } catch (err: any) {
            console.error(`Failed to update DB for CC ${matchedStudent.cc}:`, err.message);
            reportRows.push({
                CSV_Row_Num: csvRowNum,
                Sheet_Name: sheetName,
                CSV_CC: csvCCRaw,
                CSV_GR: csvGRRaw,
                CSV_Student_Name: csvName,
                Matched_DB_CC: String(matchedStudent.cc),
                Matched_DB_Student_Name: matchedStudent.full_name,
                Match_Method: matchMethod,
                CSV_Raw_DOB: csvDOBRaw,
                Parsed_DOB: parsedDOBStr,
                Old_DB_DOB: oldDBDOBStr,
                New_DB_DOB: oldDBDOBStr,
                Status: 'INVALID_DOB_SKIPPED',
                Reason: `Database update error: ${err.message}`
            });
        }
    }

    // Write Full Report CSV
    const fullCsvOutput = exportToCSV(reportRows);
    fs.writeFileSync(fullReportPath, fullCsvOutput, 'utf8');

    // Write Updates-Only Report CSV
    const updatedOnlyRows = reportRows.filter(r => r.Status === 'UPDATED');
    const updatesOnlyCsvOutput = exportToCSV(updatedOnlyRows);
    fs.writeFileSync(updatesOnlyReportPath, updatesOnlyCsvOutput, 'utf8');

    console.log(`Summary for ${path.basename(csvPath)}:`);
    console.log(`- Evaluated:          ${records.length}`);
    console.log(`- Updated in DB:      ${totalUpdated}`);
    console.log(`- Already Identical:  ${totalUnchanged}`);
    console.log(`- Invalid/Blank DOB:  ${totalInvalidDOB}`);
    console.log(`- Name Mismatch Skip: ${totalNameMismatchSkipped}`);
    console.log(`- Unmatched:          ${totalNotFound}`);
    console.log(`- Full Audit Report:  ${fullReportPath}`);
    console.log(`- Updates-Only CSV:   ${updatesOnlyReportPath}`);
}

async function main() {
    const dir = path.join(__dirname, '../dob-update-july26');
    
    // GKF
    await processSingleFile(
        path.join(dir, 'STUDENT PROFILE (GKF) 2027.csv'),
        path.join(dir, 'dob_update_report_GKF_2026_07_27.csv'),
        path.join(dir, 'dob_updates_only_report_GKF_2026_07_27.csv')
    );

    // NNN
    await processSingleFile(
        path.join(dir, 'STUDENT PROFILE(NNN) 2026-2027.csv'),
        path.join(dir, 'dob_update_report_NNN_2026_07_27.csv'),
        path.join(dir, 'dob_updates_only_report_NNN_2026_07_27.csv')
    );
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
