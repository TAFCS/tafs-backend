import { DEFAULT_TERM_START_MONTH } from './academic-labels';

type ClassTermReader = {
    classes: {
        findMany: (args: {
            select: { id: true; term_start_month: true };
        }) => Promise<Array<{ id: number; term_start_month: number }>>;
    };
};

/**
 * class_id -> classes.term_start_month, memoised for the process lifetime.
 *
 * Safe to hold indefinitely: `classes` is ~21 rows and nothing writes
 * term_start_month — ClassesService.create and bulkUpdate both omit it, and the
 * only values that exist were set by migration
 * 20260510000000_add_term_start_month_and_test_data. If that ever changes, the
 * writer must call resetClassTermMapCache().
 */
let cache: Map<number, number> | null = null;
let inflight: Promise<Map<number, number>> | null = null;

export async function getClassTermMap(prisma: ClassTermReader): Promise<ReadonlyMap<number, number>> {
    if (cache) return cache;
    // Share one query between concurrent callers rather than letting every
    // in-flight request issue its own on a cold cache.
    if (!inflight) {
        inflight = prisma.classes
            .findMany({ select: { id: true, term_start_month: true } })
            .then((rows) => {
                cache = new Map(rows.map((c) => [c.id, c.term_start_month]));
                return cache;
            })
            .finally(() => {
                inflight = null;
            });
    }
    return inflight;
}

export function resetClassTermMapCache(): void {
    cache = null;
    inflight = null;
}

/**
 * The term a fee head created against `classId` should be stamped with.
 *
 * Falls back to Aug-Jul when the class is unknown, which matches the column
 * default and what every reader assumed before term_start_month existed.
 */
export function termStartMonthForClass(
    classId: number | null | undefined,
    classTerms: ReadonlyMap<number, number>,
): number {
    if (classId == null) return DEFAULT_TERM_START_MONTH;
    return classTerms.get(Number(classId)) ?? DEFAULT_TERM_START_MONTH;
}
