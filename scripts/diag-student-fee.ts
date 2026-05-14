import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
    const studentId = 7466;
    console.log(`Diagnostic for student ${studentId}:`);
    const records = await prisma.student_fees.findMany({
        where: { student_id: studentId, fee_type_id: 1 },
        orderBy: [{ academic_year: 'asc' }, { target_month: 'asc' }]
    });
    console.table(records.map(r => ({
        month: r.target_month,
        year: r.academic_year,
        amount: r.amount?.toString(),
        is_discount: r.is_discount,
        is_arrear: r.is_arrear_surcharge,
        status: r.status
    })));
}
main().finally(() => prisma.$disconnect());
