import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log('--- Distinct Academic Years in student_fees ---');
    const academicYears = await prisma.student_fees.findMany({
        select: { academic_year: true },
        distinct: ['academic_year']
    });
    console.log('Academic years in DB:', academicYears.map(a => a.academic_year));

    const targetClasses = [15, 16, 17, 18, 19];

    // Get all students in classes 15, 16, 17, 18, 19
    const studentsInClasses = await prisma.students.findMany({
        where: {
            class_id: { in: targetClasses },
            deleted_at: null
        },
        select: {
            cc: true,
            full_name: true,
            gr_number: true,
            status: true,
            class_id: true,
            section_id: true,
            campus_id: true
        },
        orderBy: [{ class_id: 'asc' }, { cc: 'asc' }]
    });

    console.log(`Total active (non-deleted) students in classes [15, 16, 17, 18, 19]: ${studentsInClasses.length}`);

    // Break down by status
    const statusCounts: Record<string, number> = {};
    for (const s of studentsInClasses) {
        statusCounts[s.status] = (statusCounts[s.status] || 0) + 1;
    }
    console.log('Student breakdown by status:', statusCounts);

    // Let's check academic_year string matching ('2026-2027', '2026-27', etc.)
    const feeYears = academicYears.map(a => a.academic_year);
    const matchingYear = feeYears.find(y => y.includes('2026') && y.includes('2027')) || '2026-2027';

    console.log(`\nChecking student_fees for academic_year: "${matchingYear}"`);

    // Fetch all student_fees for matchingYear for these students
    const studentCcs = studentsInClasses.map(s => s.cc);

    const feeRecords = await prisma.student_fees.findMany({
        where: {
            student_id: { in: studentCcs },
            academic_year: matchingYear
        },
        select: {
            student_id: true,
            fee_type_id: true,
            target_month: true,
            academic_year: true,
            amount: true,
            status: true
        }
    });

    const studentsWithFeesSet = new Set(feeRecords.map(f => f.student_id));

    console.log(`Total fee records found for ${matchingYear}: ${feeRecords.length}`);
    console.log(`Unique students with at least 1 fee record in ${matchingYear}: ${studentsWithFeesSet.size}`);

    // Find missing students
    const missingStudents = studentsInClasses.filter(s => !studentsWithFeesSet.has(s.cc));
    const missingEnrolled = missingStudents.filter(s => s.status === 'ENROLLED');

    console.log(`\nMissing students overall: ${missingStudents.length}`);
    console.log(`Missing ENROLLED students: ${missingEnrolled.length}`);

    if (missingStudents.length > 0) {
        console.log('\n--- Missing Students List ---');
        console.table(missingStudents.map(s => ({
            cc: s.cc,
            gr: s.gr_number,
            name: s.full_name,
            class_id: s.class_id,
            section_id: s.section_id,
            status: s.status
        })));
    }

    // Also breakdown count per class
    console.log('\n--- Per-Class Breakdown ---');
    for (const cid of targetClasses) {
        const inClass = studentsInClasses.filter(s => s.class_id === cid);
        const inClassEnrolled = inClass.filter(s => s.status === 'ENROLLED');
        const withFees = inClass.filter(s => studentsWithFeesSet.has(s.cc));
        const withFeesEnrolled = inClassEnrolled.filter(s => studentsWithFeesSet.has(s.cc));

        console.log(`Class ${cid}:`);
        console.log(`  Total: ${inClass.length} (Enrolled: ${inClassEnrolled.length})`);
        console.log(`  With Fees for ${matchingYear}: ${withFees.length} (Enrolled: ${withFeesEnrolled.length})`);
        console.log(`  Missing Fees: ${inClass.length - withFees.length} (Enrolled Missing: ${inClassEnrolled.length - withFeesEnrolled.length})`);
    }
}

main()
    .catch(e => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
