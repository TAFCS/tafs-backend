import { PrismaClient } from '@prisma/client';
import fs from 'fs';

const prisma = new PrismaClient();

async function main() {
    const outputPath = '/Users/aawaizali/Desktop/TAFS/tafs-backend/recoveries-april/students_with_no_fees_post_april.csv';

    console.log(`Running optimized query to find students with no fees after April 2026...`);

    const studentsWithNoFees = await prisma.$queryRaw`
        SELECT 
            s.cc, 
            s.full_name as name, 
            cp.campus_name as campus, 
            cl.description as class, 
            sc.description as section
        FROM students s
        LEFT JOIN campuses cp ON s.campus_id = cp.id
        LEFT JOIN classes cl ON s.class_id = cl.id
        LEFT JOIN sections sc ON s.section_id = sc.id
        WHERE s.status = 'ENROLLED' 
          AND s.deleted_at IS NULL
          AND s.cc NOT IN (
            SELECT DISTINCT student_id 
            FROM student_fees 
            WHERE fee_date > '2026-04-01'::date
          )
    ` as any[];

    console.log(`Query complete. Found ${studentsWithNoFees.length} students.`);

    // Convert to CSV
    const csvHeader = 'cc,full_name,campus_name,class_name,section_name\n';
    const csvRows = studentsWithNoFees.map(r => `"${r.cc}","${r.name.replace(/"/g, '""')}","${r.campus || 'N/A'}","${r.class || 'N/A'}","${r.section || 'N/A'}"`).join('\n');
    
    fs.writeFileSync(outputPath, csvHeader + csvRows);

    console.log(`Saved to ${outputPath}`);
}

main()
    .catch(e => { console.error(e); process.exit(1); })
    .finally(async () => { await prisma.$disconnect(); });
