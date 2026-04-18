import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import { parse } from 'csv-parse/sync';

const prisma = new PrismaClient();

async function main() {
    const csvPath = '/Users/aawaizali/Desktop/TAFS/tafs-backend/students-data/genders.csv';
    
    if (!fs.existsSync(csvPath)) {
        console.error(`CSV file not found at ${csvPath}`);
        return;
    }

    const fileContent = fs.readFileSync(csvPath, 'utf8');
    const records: any[] = parse(fileContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true
    });

    console.log(`Optimized processing for ${records.length} records...`);

    // 1. Get all base CCs to avoid invalid updates
    const studentsInDb = await prisma.students.findMany({ select: { cc: true } });
    const existingCcs = new Set(studentsInDb.map(s => Number(s.cc)));
    
    console.log(`Found ${existingCcs.size} students in database.`);

    let updatedCount = 0;
    const chunkSize = 20; // Smaller chunk size to avoid overloading DB connections

    for (let i = 0; i < records.length; i += chunkSize) {
        const chunk = records.slice(i, i + chunkSize);
        
        const updatePromises = chunk.map(async (record) => {
            const ccStr = record['Student Id'];
            const cc = parseInt(ccStr);
            const dobStr = record['Date Of Birth'];
            const doaStr = record['Admission Date'];
            const gender = record['Gender Name'];

            if (isNaN(cc)) return false;
            
            if (!existingCcs.has(cc)) {
                // If it's a small ID, maybe it's padded? But from our check CC 1 existed.
                return false;
            }

            try {
                await prisma.students.update({
                    where: { cc },
                    data: {
                        dob: dobStr && dobStr !== '' ? new Date(dobStr) : null,
                        doa: doaStr && doaStr !== '' ? new Date(doaStr) : null,
                        gender: gender || null
                    }
                });
                return true;
            } catch (err: any) {
                console.error(`Error updating CC ${cc}: ${err.message}`);
                return false;
            }
        });

        const results = await Promise.all(updatePromises);
        updatedCount += results.filter(r => r === true).length;
        if (i % 100 === 0) {
            console.log(`Progress: Processed up to record ${Math.min(i + chunkSize, records.length)}... (Updates so far: ${updatedCount})`);
        }
    }

    console.log('--- Optimized Import Summary ---');
    console.log(`Total Records in CSV: ${records.length}`);
    console.log(`Students in DB: ${existingCcs.size}`);
    console.log(`Successfully Updated: ${updatedCount}`);
}

main()
    .catch(e => { console.error(e); process.exit(1); })
    .finally(async () => { await prisma.$disconnect(); });
