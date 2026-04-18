import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import { parse } from 'csv-parse/sync';

const prisma = new PrismaClient();

async function main() {
    const csvPath = '/Users/aawaizali/Desktop/TAFS/tafs-backend/students-data/genders.csv';
    const fileContent = fs.readFileSync(csvPath, 'utf8');
    const records: any[] = parse(fileContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true
    });

    console.log(`Starting name-based update for ${records.length} records...`);

    const studentsInDb = await prisma.students.findMany({
        select: { cc: true, full_name: true }
    });

    // Map: NAME -> CCs
    const nameMap = new Map<string, number[]>();
    studentsInDb.forEach(s => {
        const name = s.full_name.trim().toUpperCase();
        if (!nameMap.has(name)) nameMap.set(name, []);
        nameMap.get(name)!.push(s.cc);
    });

    console.log(`Mapped ${nameMap.size} unique names from database.`);

    let updatedCount = 0;
    let skippedMultiCount = 0;
    let notFoundCount = 0;

    const chunkSize = 50;

    for (let i = 0; i < records.length; i += chunkSize) {
        const chunk = records.slice(i, i + chunkSize);
        
        const updatePromises = chunk.map(async (record) => {
            const name = record['Student Name'].trim().toUpperCase();
            const dobStr = record['Date Of Birth'];
            const doaStr = record['Admission Date'];
            const gender = record['Gender Name'];

            const matches = nameMap.get(name);

            if (!matches) {
                notFoundCount++;
                return false;
            }

            if (matches.length > 1) {
                // Too risky to update without more info
                skippedMultiCount++;
                return false;
            }

            const cc = matches[0];

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
            } catch (err) {
                return false;
            }
        });

        const results = await Promise.all(updatePromises);
        updatedCount += results.filter(r => r === true).length;
        if (i % 200 === 0) {
            console.log(`Progress: ${i}/${records.length} records processed...`);
        }
    }

    console.log('--- Name Match Summary ---');
    console.log(`Successfully Updated: ${updatedCount}`);
    console.log(`Skipped (Ambiguous/Multiple Names): ${skippedMultiCount}`);
    console.log(`Not Found in DB: ${notFoundCount}`);
}

main()
    .catch(e => { console.error(e); process.exit(1); })
    .finally(async () => { await prisma.$disconnect(); });
