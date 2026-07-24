import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    const targetClasses = [15, 16, 17, 18, 19];

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
          AND s.cc NOT IN (
            SELECT DISTINCT student_id 
            FROM student_fees 
            WHERE academic_year = '2026-2027'
          )
        ORDER BY s.class_id, s.cc
    ` as any[];

    console.log(JSON.stringify(missingDetails, null, 2));
}

main().finally(() => prisma.$disconnect());
