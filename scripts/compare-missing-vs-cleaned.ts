import fs from 'fs';
import { parse } from 'csv-parse/sync';

function compare() {
    const missingPath = '/Users/aawaizali/Desktop/TAFS/tafs-backend/recoveries-april/missing_fees.csv';
    const cleanedPath = '/Users/aawaizali/Desktop/TAFS/tafs-backend/recoveries-april/cleaned_fees_heads.csv';
    const outputPath = '/Users/aawaizali/Desktop/TAFS/tafs-backend/recoveries-april/comparison_mismatches_log.csv';

    const missingContent = fs.readFileSync(missingPath, 'utf8');
    const cleanedContent = fs.readFileSync(cleanedPath, 'utf8');

    const missingRecords = parse(missingContent, { columns: true, skip_empty_lines: true, trim: true });
    const cleanedRecords = parse(cleanedContent, { columns: true, skip_empty_lines: true, trim: true });

    const missingCcs = new Set(missingRecords.map((r: any) => r.cc));
    const cleanedCcs = new Set(cleanedRecords.map((r: any) => r.cc));

    const results: any[] = [];

    // Found in Missing but not in Cleaned
    missingCcs.forEach(cc => {
        if (!cleanedCcs.has(cc)) {
            results.push({ cc, status: 'Only in missing_fees.csv' });
        }
    });

    // Found in Cleaned but not in Missing
    cleanedCcs.forEach(cc => {
        if (!missingCcs.has(cc)) {
            results.push({ cc, status: 'Only in cleaned_fees_heads.csv' });
        }
    });

    // Create CSV content
    const csvHeader = 'cc,status\n';
    const csvRows = results.map(r => `${r.cc},${r.status}`).join('\n');
    fs.writeFileSync(outputPath, csvHeader + csvRows);

    console.log(`Comparison complete. ${results.length} mismatches found.`);
    console.log(`Log saved to ${outputPath}`);
}

compare();
