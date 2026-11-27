import type { Prisma, PrismaClient } from '@prisma/client';

type Reader = Pick<PrismaClient, 'ec_class_fee_schedule'> | Prisma.TransactionClient;

export type ClassAmountLookup = (campusId: number | null | undefined, classId: number | null | undefined, headId: number) => number | null;

/**
 * TAFSD-605: the class amount a student is charged for a head in a year. The
 * row for the student's own campus beats the all-campus row; with neither, the
 * head has no class amount for that class and the caller must skip or ask for
 * a custom amount.
 */
export async function loadClassAmounts(
    prisma: Reader,
    academicYear: string,
    headIds: number[],
    classIds: number[],
): Promise<ClassAmountLookup> {
    const rows =
        headIds.length && classIds.length
            ? await prisma.ec_class_fee_schedule.findMany({
                  where: { academic_year: academicYear, fee_head_id: { in: headIds }, class_id: { in: classIds } },
                  select: { class_id: true, fee_head_id: true, campus_id: true, amount: true },
              })
            : [];
    const byKey = new Map<string, number>();
    for (const r of rows) byKey.set(`${r.class_id}|${r.fee_head_id}|${r.campus_id ?? 'all'}`, Number(r.amount));

    return (campusId, classId, headId) => {
        if (classId == null) return null;
        if (campusId != null) {
            const own = byKey.get(`${classId}|${headId}|${campusId}`);
            if (own != null) return own;
        }
        return byKey.get(`${classId}|${headId}|all`) ?? null;
    };
}
