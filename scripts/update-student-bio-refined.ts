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

    console.log(`Starting refined name-based update (with logic for duplicates)...`);

    const studentsInDb = await prisma.students.findMany({
        select: { cc: true, full_name: true, dob: true, doa: true }
    });

    // Map: NAME -> Student Objects
    const nameMap = new Map<string, any[]>();
    studentsInDb.forEach(s => {
        const name = s.full_name.trim().toUpperCase();
        if (!nameMap.has(name)) nameMap.set(name, []);
        nameMap.get(name)!.push(s);
    });

    let updatedCount = 0;
    let fallbackUpdatedCount = 0;
    let ambiguousCount = 0;

    const chunkSize = 50;

    for (let i = 0; i < records.length; i += chunkSize) {
        const chunk = records.slice(i, i + chunkSize);
        
        const updatePromises = chunk.map(async (record) => {
            const name = record['Student Name'].trim().toUpperCase();
            const dobStr = record['Date Of Birth'];
            const doaStr = record['Admission Date'];
            const gender = record['Gender Name'];

            const matches = nameMap.get(name);
            if (!matches) return false;

            let targetCc: number | null = null;

            if (matches.length === 1) {
                targetCc = matches[0].cc;
            } else {
                // TIE BREAKER: Match by DOB or DOA if available
                const csvDob = dobStr ? new Date(dobStr).toISOString().split('T')[0] : null;
                const matchesByDob = matches.filter(m => {
                    const dbDob = m.dob ? new Date(m.dob).toISOString().split('T')[0] : null;
                    return dbDob === csvDob;
                });

                if (matchesByDob.length === 1) {
                    targetCc = matchesByDob[0].cc;
                    fallbackUpdatedCount++;
                } else {
                    ambiguousCount++;
                    return false;
                }
            }

            try {
                await prisma.students.update({
                    where: { cc: targetCc! },
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
    }

    console.log('--- Refined Match Summary ---');
    console.log(`Total Records Processed: ${records.length}`);
    console.log(`Successfully Updated: ${updatedCount}`);
    console.log(`Resolved via Tie-breaker (DOB): ${fallbackUpdatedCount}`);
    console.log(`Still Ambiguous: ${ambiguousCount}`);
}

main().finally(() => prisma.$disconnect());
