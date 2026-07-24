import { PrismaClient } from '@prisma/client';
import fs from 'fs';

const prisma = new PrismaClient();

async function main() {
    const missingDetails = await prisma.$queryRaw`
        SELECT 
            s.cc,
            s.gr_number,
            s.full_name,
            s.status,
            s.class_id,
            cl.description as class_name,
            sc.description as section_name,
            cp.campus_name
        FROM students s
        LEFT JOIN classes cl ON s.class_id = cl.id
        LEFT JOIN sections sc ON s.section_id = sc.id
        LEFT JOIN campuses cp ON s.campus_id = cp.id
        WHERE s.class_id IN (15, 16, 17, 18, 19)
          AND s.deleted_at IS NULL
          AND s.status != 'LEFT'
          AND s.cc NOT IN (
            SELECT DISTINCT student_id 
            FROM student_fees 
            WHERE academic_year = '2026-2027'
          )
        ORDER BY s.class_id, s.cc
    ` as any[];

    const filePath = '/Users/aawaizali/Desktop/TAFS/tafs-backend/missing_fees_2026_2027_classes_15_19.txt';

    let content = `================================================================================\n`;
    content += `MISSING 2026-2027 STUDENT FEES REPORT (CLASSES 15, 16, 17, 18, 19)\n`;
    content += `STATUS: EXCLUDING 'LEFT' STUDENTS\n`;
    content += `TOTAL COUNT: ${missingDetails.length}\n`;
    content += `================================================================================\n\n`;

    content += `CC\tGR Number\tStudent Name\t\t\tClass ID\tClass\tSection\tCampus\n`;
    content += `----------------------------------------------------------------------------------------------------\n`;

    missingDetails.forEach(s => {
        const gr = s.gr_number || 'N/A';
        const sec = s.section_name || 'Unassigned';
        content += `${s.cc}\t${gr}\t${s.full_name.padEnd(30)}\t${s.class_id}\t${s.class_name}\t${sec}\t${s.campus_name}\n`;
    });

    fs.writeFileSync(filePath, content);
    console.log(`Saved report to ${filePath} (${missingDetails.length} students)`);
}

main().finally(() => prisma.$disconnect());
