import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
    console.log("Analyzing student_fees (Type 1) using amount_before_discount...");
    
    const fees = await prisma.student_fees.findMany({
        where: {
            fee_type_id: 1,
            is_discount: false,
            is_arrear_surcharge: false
        },
        select: {
            student_id: true,
            amount_before_discount: true,
            academic_year: true
        }
    });

    const map = new Map<number, Map<string, Set<string>>>();
    for (const f of fees) {
        if (!f.amount_before_discount) continue;
        const amt = f.amount_before_discount.toString();
        if (!map.has(f.student_id)) map.set(f.student_id, new Map());
        const yrMap = map.get(f.student_id)!;
        if (!yrMap.has(f.academic_year)) yrMap.set(f.academic_year, new Set());
        yrMap.get(f.academic_year)!.add(amt);
    }

    const flagged: any[] = [];
    for (const [sId, yrMap] of map.entries()) {
        for (const [yr, amts] of yrMap.entries()) {
            if (amts.size > 1) {
                flagged.push({ studentId: sId, year: yr, amounts: Array.from(amts).join(', ') });
            }
        }
    }

    const uniqueIds = Array.from(new Set(flagged.map(f => f.studentId)));
    console.log(`\nFound ${uniqueIds.length} students with discrepancies in 'amount_before_discount' within a year:`);
    if (uniqueIds.length > 0) {
        console.log(uniqueIds.join(', '));
        console.log("\nDetailed discrepancies:");
        console.table(flagged);
    } else {
        console.log("No discrepancies found.");
    }
}

main()
    .catch(e => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
