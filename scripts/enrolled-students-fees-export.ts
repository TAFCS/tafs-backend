import { PrismaClient } from '@prisma/client';
import fs from 'fs';

const prisma = new PrismaClient();
const OUTPUT_PATH = '/Users/aawaizali/Desktop/TAFS/enrolled-students-fees-may-sep26.csv';
const FEE_TYPE_ID = 1;

const PERIODS = [
    { month: 5, label: 'May-26',  academicYear: '2025-2026' },
    { month: 6, label: 'Jun-26',  academicYear: '2025-2026' },
    { month: 7, label: 'Jul-26',  academicYear: '2025-2026' },
    { month: 8, label: 'Aug-26',  academicYear: '2026-2027' },
    { month: 9, label: 'Sep-26',  academicYear: '2026-2027' },
];

const periodKey = (month: number, ay: string) => `${ay}:${month}`;

function csvCell(val: string | number | null | undefined): string {
    const s = val == null ? '' : String(val);
    return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"`
        : s;
}

async function main() {
    const students = await prisma.students.findMany({
        where: { status: 'ENROLLED', deleted_at: null },
        select: {
            cc: true,
            gr_number: true,
            full_name: true,
            is_complementary: true,
            is_fee_endowment: true,
            classes: { select: { description: true } }
        },
        orderBy: { cc: 'asc' }
    });

    console.log(`Enrolled students: ${students.length}`);

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
        }
    });

    console.log(`Fee rows fetched: ${allFees.length}`);

    const feeMap = new Map<number, Map<string, typeof allFees[0]>>();
    for (const f of allFees) {
        const k = periodKey(f.target_month, f.academic_year);
        if (!feeMap.has(f.student_id)) feeMap.set(f.student_id, new Map());
        if (!feeMap.get(f.student_id)!.has(k)) {
            feeMap.get(f.student_id)!.set(k, f);
        }
    }

    const header = ['CC', 'GR', 'Full Name', 'Class', ...PERIODS.map(p => p.label), 'Note'];
    const lines: string[] = [header.join(',')];

    for (const s of students) {
        const pmap = feeMap.get(s.cc);
        let note = '';
        if (!pmap || pmap.size === 0) {
            if (s.is_complementary) note = 'COMPLEMENTARY';
            else if (s.is_fee_endowment) note = 'FEE_ENDOWMENT';
        }

        const row = [
            csvCell(s.cc),
            csvCell(s.gr_number),
            csvCell(s.full_name),
            csvCell(s.classes?.description),
            ...PERIODS.map(p => {
                const fee = pmap?.get(periodKey(p.month, p.academicYear));
                return csvCell(fee?.amount != null ? fee.amount.toString() : '');
            }),
            csvCell(note),
        ];
        lines.push(row.join(','));
    }

    fs.writeFileSync(OUTPUT_PATH, lines.join('\n'), 'utf8');
    console.log(`Saved to ${OUTPUT_PATH}`);
}

main()
    .catch(e => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
