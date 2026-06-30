import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const FEE_TYPE_ID = 1;

// May, Jun, Jul → academic year '2025-2026'; Aug, Sep → '2026-2027'
const PERIODS: { month: number; label: string; academicYear: string }[] = [
    { month: 5, label: 'May-26',  academicYear: '2025-2026' },
    { month: 6, label: 'Jun-26',  academicYear: '2025-2026' },
    { month: 7, label: 'Jul-26',  academicYear: '2025-2026' },
    { month: 8, label: 'Aug-26',  academicYear: '2026-2027' },
    { month: 9, label: 'Sep-26',  academicYear: '2026-2027' },
];

async function main() {
    // --- 1. Fetch all enrolled students with class info ---
    const students = await prisma.students.findMany({
        where: {
            status: 'ENROLLED',
            deleted_at: null,
        },
        select: {
            cc: true,
            gr_number: true,
            full_name: true,
            is_complementary: true,
            is_fee_endowment: true,
            classes: {
                select: { description: true }
            }
        },
        orderBy: { cc: 'asc' }
    });

    console.log(`\nDRY RUN — Enrolled Students Fees CSV`);
    console.log(`=====================================`);
    console.log(`Total enrolled students: ${students.length}`);

    // --- 2. Fetch all fee_type_id=1 rows for the target periods ---
    const allFees = await prisma.student_fees.findMany({
        where: {
            fee_type_id: FEE_TYPE_ID,
            is_discount: false,
            is_arrear_surcharge: false,
            OR: [
                { academic_year: '2025-2026', target_month: { in: [5, 6, 7] } },
                { academic_year: '2026-2027', target_month: { in: [8, 9] } },
            ]
        },
        select: {
            student_id: true,
            target_month: true,
            academic_year: true,
            amount: true,
            status: true,
            amount_paid: true,
        }
    });

    console.log(`\nFee rows fetched (fee_type_id=${FEE_TYPE_ID}, May-Sep-26): ${allFees.length}`);

    // --- 3. Per-period breakdown in DB ---
    console.log(`\nDB rows per period (fee_type_id=${FEE_TYPE_ID}):`);
    for (const p of PERIODS) {
        const count = allFees.filter(f => f.target_month === p.month && f.academic_year === p.academicYear).length;
        console.log(`  ${p.label} (${p.academicYear}, month ${p.month}): ${count} rows`);
    }

    // --- 4. Build map: studentId -> periodKey -> fee row ---
    const periodKey = (month: number, ay: string) => `${ay}:${month}`;
    const feeMap = new Map<number, Map<string, typeof allFees[0]>>();
    for (const f of allFees) {
        const k = periodKey(f.target_month, f.academic_year);
        if (!feeMap.has(f.student_id)) feeMap.set(f.student_id, new Map());
        if (!feeMap.get(f.student_id)!.has(k)) {
            feeMap.get(f.student_id)!.set(k, f);
        }
    }

    // --- 5. Stats ---
    let studentsWithAnyFees = 0;
    let studentsNoFees = 0;
    let complementaryCount = 0;
    let endowmentCount = 0;
    let noFeeNorFlag = 0;

    for (const s of students) {
        const pmap = feeMap.get(s.cc);
        if (pmap && pmap.size > 0) {
            studentsWithAnyFees++;
        } else {
            studentsNoFees++;
            if (s.is_complementary) complementaryCount++;
            else if (s.is_fee_endowment) endowmentCount++;
            else noFeeNorFlag++;
        }
    }

    console.log(`\nStudents with ≥1 fee row (May-Sep, fee_type=${FEE_TYPE_ID}): ${studentsWithAnyFees}`);
    console.log(`Students with NO fee rows in those months:  ${studentsNoFees}`);
    console.log(`  - is_complementary:  ${complementaryCount}`);
    console.log(`  - is_fee_endowment:  ${endowmentCount}`);
    console.log(`  - neither flag:      ${noFeeNorFlag}`);

    // --- 6. Per-period enrolled coverage ---
    console.log(`\nEnrolled-student coverage per period:`);
    for (const p of PERIODS) {
        const k = periodKey(p.month, p.academicYear);
        const count = students.filter(s => feeMap.get(s.cc)?.has(k)).length;
        console.log(`  ${p.label}: ${count} / ${students.length}`);
    }

    // --- 7. Sample output (first 5 rows) ---
    console.log(`\nSample output (first 5 enrolled students):`);
    const headerCols = ['CC', 'GR', 'Full Name', 'Class'];
    for (const p of PERIODS) {
        headerCols.push(`${p.label} Amount`, `${p.label} Status`);
    }
    headerCols.push('Note');
    console.log(headerCols.join(' | '));
    console.log('-'.repeat(140));

    for (const s of students.slice(0, 5)) {
        const row: string[] = [
            String(s.cc),
            s.gr_number || '',
            s.full_name,
            s.classes?.description || ''
        ];

        const pmap = feeMap.get(s.cc);
        let note = '';
        if (!pmap || pmap.size === 0) {
            if (s.is_complementary) note = 'COMPLEMENTARY';
            else if (s.is_fee_endowment) note = 'FEE_ENDOWMENT';
        }

        for (const p of PERIODS) {
            const fee = pmap?.get(periodKey(p.month, p.academicYear));
            if (fee) {
                row.push(fee.amount?.toString() || '0', fee.status || '');
            } else {
                row.push('', '');
            }
        }
        row.push(note);
        console.log(row.join(' | '));
    }

    console.log(`\nPlanned CSV columns (${headerCols.length} total):`);
    console.log(headerCols.join(', '));
    console.log(`\nDry run complete. Confirm to proceed with full export.`);
}

main()
    .catch(e => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
