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

    console.log(`Analyzing ${records.length} records by name...`);

    const studentsInDb = await prisma.students.findMany({
        select: { cc: true, full_name: true }
    });

    const nameMap = new Map<string, number[]>();
    studentsInDb.forEach(s => {
        const name = s.full_name.trim().toUpperCase();
        if (!nameMap.has(name)) nameMap.set(name, []);
        nameMap.get(name)!.push(s.cc);
    });

    console.log(`Database has ${studentsInDb.length} students.`);

    let matchedUnique = 0;
    let matchedMulti = 0;
    let notMatched = 0;

    for (const record of records) {
        const name = record['Student Name'].trim().toUpperCase();
        const matches = nameMap.get(name);

        if (!matches) {
            notMatched++;
        } else if (matches.length === 1) {
            matchedUnique++;
        } else {
            matchedMulti++;
        }
    }

    console.log(`Matches logic check:`);
    console.log(`Unique name matches: ${matchedUnique}`);
    console.log(`Multiple name matches: ${matchedMulti}`);
    console.log(`No name matches: ${notMatched}`);
}

main().finally(() => prisma.$disconnect());
