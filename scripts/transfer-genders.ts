import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import { parse } from 'csv-parse/sync';

const prisma = new PrismaClient();

async function main() {
    const csvPath = '/Users/aawaizali/Desktop/TAFS/tafs-backend/data-audits/GENDERS.csv';
    const fileContent = fs.readFileSync(csvPath, 'utf8');
    
    // The CSV has an unnamed last column for Gender
    const records: any[] = parse(fileContent, {
        columns: ['cc', 'full_name', 'father_name', 'gr_number', 'class', 'gender'],
        from_line: 2, // Skip header
        skip_empty_lines: true,
        trim: true
    });

    console.log(`Starting gender transfer for ${records.length} records...`);

    let updatedCount = 0;
    let errorCount = 0;
    let notFoundCount = 0;

    const chunkSize = 50;

    for (let i = 0; i < records.length; i += chunkSize) {
        const chunk = records.slice(i, i + chunkSize);
        
        const updatePromises = chunk.map(async (record) => {
            const cc = parseInt(record.cc);
            const gender = record.gender;

            if (isNaN(cc)) {
                console.error(`Invalid CC: ${record.cc}`);
                errorCount++;
                return;
            }

            try {
                const student = await prisma.students.findUnique({
                    where: { cc: cc }
                });

                if (!student) {
                    console.warn(`Student with CC ${cc} not found.`);
                    notFoundCount++;
                    return;
                }

                await prisma.students.update({
                    where: { cc: cc },
                    data: {
                        gender: gender || null
                    }
                });
                updatedCount++;
            } catch (err: any) {
                console.error(`Error updating CC ${cc}: ${err.message}`);
                errorCount++;
            }
        });

        await Promise.all(updatePromises);
    }

    console.log('--- Gender Transfer Summary ---');
    console.log(`Total Records: ${records.length}`);
    console.log(`Successfully Updated: ${updatedCount}`);
    console.log(`Not Found: ${notFoundCount}`);
    console.log(`Errors: ${errorCount}`);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
