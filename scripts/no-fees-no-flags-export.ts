import { PrismaClient } from '@prisma/client';
import fs from 'fs';

const prisma = new PrismaClient();
const OUTPUT_PATH = '/Users/aawaizali/Desktop/TAFS/students-no-fees-no-flags.csv';

function csvCell(val: string | number | null | undefined): string {
    const s = val == null ? '' : String(val);
    return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"`
        : s;
}

async function main() {
    const students = await prisma.students.findMany({
        where: {
            status: 'ENROLLED',
            deleted_at: null,
            is_complementary: false,
            is_fee_endowment: false,
        },
        select: {
            cc: true,
            gr_number: true,
            full_name: true,
            classes: { select: { description: true } },
            campuses: { select: { campus_name: true } },
        },
        orderBy: { cc: 'asc' }
    });

    const ccs = students.map(s => s.cc);

    const withFees = await prisma.student_fees.findMany({
        where: { student_id: { in: ccs } },
        select: { student_id: true },
        distinct: ['student_id'],
    });
    const withFeeSet = new Set(withFees.map(f => f.student_id));

    const noFees = students.filter(s => !withFeeSet.has(s.cc));

    console.log(`Enrolled students with no complementary/fee-endowment flag: ${students.length}`);
    console.log(`Of those, with zero student_fees rows: ${noFees.length}`);

    const header = ['CC', 'GR', 'Full Name', 'Campus', 'Class'];
    const lines = [header.join(',')];

    for (const s of noFees) {
        lines.push([
            csvCell(s.cc),
            csvCell(s.gr_number),
            csvCell(s.full_name),
            csvCell(s.campuses?.campus_name),
            csvCell(s.classes?.description),
        ].join(','));
    }

    fs.writeFileSync(OUTPUT_PATH, lines.join('\n'), 'utf8');
    console.log(`Saved to ${OUTPUT_PATH}`);
}

main()
    .catch(e => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
