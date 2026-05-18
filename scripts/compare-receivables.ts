import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import { parse } from 'csv-parse/sync';

const prisma = new PrismaClient();

async function main() {
    // Get CSV path from command line arguments, fallback to GKFS if not provided
    const defaultCsv = '/Users/aawaizali/Desktop/TAFS/tafs-backend/june-26-esm/GKFSJUNE26.csv';
    const csvPath = process.argv[2] || defaultCsv;

    if (!fs.existsSync(csvPath)) {
        console.error(`Error: CSV file not found at ${csvPath}`);
        return;
    }

    console.log(`Reading CSV from ${csvPath}...`);
    const fileContent = fs.readFileSync(csvPath, 'utf8');
    const records: any[] = parse(fileContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true
    });

    console.log(`Parsed ${records.length} student records from CSV.`);

    // Extract all student IDs (cc) from records to build the IN query
    const studentCcs: number[] = [];
    const ccToReceivable = new Map<number, number>();

    for (let i = 0; i < records.length; i++) {
        const record = records[i];
        const ccStr = record['C.C.'] || record['cc'] || record['CC'];
        const receivableStr = record['Receivable'] || record['receivable'];

        if (!ccStr || ccStr.trim() === '') {
            console.warn(`Row ${i + 1} has no C.C. column. Skipping.`);
            continue;
        }

        const cc = parseInt(ccStr.replace(/,/g, ''), 10);
        const csvReceivable = parseFloat(receivableStr.replace(/,/g, '')) || 0;

        if (isNaN(cc)) {
            console.warn(`Row ${i + 1} has invalid C.C. value: "${ccStr}". Skipping.`);
            continue;
        }

        studentCcs.push(cc);
        ccToReceivable.set(cc, csvReceivable);
    }

    console.log(`Querying DB for fees of ${studentCcs.length} students...`);
    const startTime = Date.now();

    // Query all student_fees in one big query
    const allFees = await prisma.student_fees.findMany({
        where: {
            student_id: {
                in: studentCcs
            },
            fee_date: {
                lte: new Date('2026-06-01')
            }
        }
    });

    console.log(`Fetched ${allFees.length} fee records in ${((Date.now() - startTime) / 1000).toFixed(2)} seconds.`);

    // Group fees by student_id
    const studentFeesMap = new Map<number, typeof allFees>();
    for (const fee of allFees) {
        if (!studentFeesMap.has(fee.student_id)) {
            studentFeesMap.set(fee.student_id, []);
        }
        studentFeesMap.get(fee.student_id)!.push(fee);
    }

    let matchedCount = 0;
    let unmatchedCount = 0;
    const reportRows: any[] = [];
    const allStatuses = new Set<string>();

    for (const cc of studentCcs) {
        const csvReceivable = ccToReceivable.get(cc) || 0;
        const fees = studentFeesMap.get(cc) || [];

        let dbTotal = 0;
        let paidCount = 0;
        let issuedCount = 0;
        let notIssuedCount = 0;
        let partiallyPaidCount = 0;
        let discountCount = 0;
        let unknownCount = 0;

        const detailsList: string[] = [];

        for (const fee of fees) {
            const status = fee.status || 'NOT_ISSUED';
            allStatuses.add(status);

            const amount = fee.amount ? Number(fee.amount) : 0;
            const amountPaid = fee.amount_paid ? Number(fee.amount_paid) : 0;

            if (status === 'PAID') {
                paidCount++;
                // ignore
            } else if (status === 'NOT_ISSUED') {
                notIssuedCount++;
                dbTotal += amount;
                detailsList.push(`NOT_ISSUED(+${amount})`);
            } else if (status === 'ISSUED') {
                issuedCount++;
                dbTotal += amount;
                detailsList.push(`ISSUED(+${amount})`);
            } else if (status === 'PARTIALLY_PAID') {
                partiallyPaidCount++;
                const unpaid = amount - amountPaid;
                dbTotal += unpaid;
                detailsList.push(`PARTIALLY_PAID(+${unpaid})`);
            } else if (status === 'DISCOUNT') {
                discountCount++;
                detailsList.push(`DISCOUNT(+0)`);
            } else {
                unknownCount++;
                dbTotal += amount;
                detailsList.push(`${status}(+${amount})`);
            }
        }

        // Compare using rounded values to avoid floating-point issues
        const roundedDbTotal = Math.round(dbTotal);
        const roundedCsvReceivable = Math.round(csvReceivable);
        const match = roundedDbTotal === roundedCsvReceivable;

        if (match) {
            matchedCount++;
        } else {
            unmatchedCount++;
        }

        const difference = roundedDbTotal - roundedCsvReceivable;
        const matchStatus = match ? 'MATCH' : 'MISMATCH';

        reportRows.push({
            cc,
            csvReceivable: roundedCsvReceivable,
            dbTotal: roundedDbTotal,
            matchStatus,
            difference,
            paidCount,
            issuedCount,
            notIssuedCount,
            partiallyPaidCount,
            discountCount,
            unknownCount,
            details: detailsList.join(' | ')
        });
    }

    const totalStudents = matchedCount + unmatchedCount;
    const matchedPercent = totalStudents > 0 ? (matchedCount / totalStudents) * 100 : 0;
    const unmatchedPercent = totalStudents > 0 ? (unmatchedCount / totalStudents) * 100 : 0;

    console.log(`\nComparison Results Summary for ${csvPath.split('/').pop()}:`);
    console.log(`Total Students Compared: ${totalStudents}`);
    console.log(`Matched: ${matchedCount} (${matchedPercent.toFixed(2)}%)`);
    console.log(`Mismatched: ${unmatchedCount} (${unmatchedPercent.toFixed(2)}%)`);
    console.log(`Unique fee statuses found in DB:`, Array.from(allStatuses));

    // Generate output CSV
    const csvHeader = 'C.C.,CSV Receivable,DB Calculated Total,Match,Difference,PAID Count,ISSUED Count,NOT_ISSUED Count,PARTIALLY_PAID Count,DISCOUNT Count,UNKNOWN Count,Details\n';
    let csvLines = reportRows.map(row => {
        return `${row.cc},${row.csvReceivable},${row.dbTotal},${row.matchStatus},${row.difference},${row.paidCount},${row.issuedCount},${row.notIssuedCount},${row.partiallyPaidCount},${row.discountCount},${row.unknownCount},"${row.details.replace(/"/g, '""')}"`;
    }).join('\n');

    // Add last row containing % ratio of matched against mismatched
    const ratioStr = `Matched: ${matchedPercent.toFixed(2)}% vs Mismatched: ${unmatchedPercent.toFixed(2)}%`;
    const lastRow = `Matched vs Mismatched Ratio,${matchedCount},${unmatchedCount},${matchedPercent.toFixed(2)}%,${unmatchedPercent.toFixed(2)}%,,,,,"${ratioStr}",,`;
    
    csvLines += '\n' + lastRow;

    // Define output names:
    // 1. Dynamic named output (e.g. GKFSJUNE26_comparison_report.csv)
    const inputFilename = csvPath.split('/').pop()?.replace('.csv', '') || 'receivables';
    const namedOutputPath = `/Users/aawaizali/Desktop/TAFS/tafs-backend/june-26-esm/${inputFilename}_comparison_report.csv`;
    
    // 2. Generic default active output file path
    const activeOutputPath = '/Users/aawaizali/Desktop/TAFS/tafs-backend/june-26-esm/receivables_comparison_report.csv';

    fs.writeFileSync(namedOutputPath, csvHeader + csvLines);
    fs.writeFileSync(activeOutputPath, csvHeader + csvLines);
    
    console.log(`\nReport generated and saved to:`);
    console.log(`1. ${namedOutputPath}`);
    console.log(`2. ${activeOutputPath}`);
}

main()
    .catch(e => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
