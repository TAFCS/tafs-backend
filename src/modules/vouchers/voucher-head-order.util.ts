import { monthAbsoluteIndex, TermContext } from '../../common/utils/academic-labels';

const FALLBACK_GROUP_KEY = '__FALLBACK__';

export interface OrderableHead<T> {
    ref: T;
    /** voucher_heads.id (or a stable synthetic id for non-DB rows). Tie-break only. */
    headId: number | null;
    feeTypeId: number | null;
    /** fee_types.priority_order. Live value, not student_fees.precedence_override. */
    priorityOrder: number | null;
    targetMonth: number | null;
    academicYear: string | null;
    term: TermContext;
    isDiscount: boolean;
}

interface ResolvedHead<T> {
    item: OrderableHead<T>;
    absIndex: number | null;
    groupKey: number | typeof FALLBACK_GROUP_KEY;
    groupPriority: number;
}

function absIndexOf<T>(item: OrderableHead<T>): number | null {
    if (item.targetMonth == null || !item.academicYear) return null;
    return monthAbsoluteIndex(item.targetMonth, item.academicYear, item.term);
}

/**
 * Matches a discount row to the fee-type group of the real head it discounts.
 *
 * There is no FK from a discount's student_fees row to the fee it reduces, so
 * this is a best-effort heuristic: same absolute month as a real head on the
 * same voucher. Zero matches -> fallback bucket. One match -> adopt its
 * fee_type_id. Multiple matches (two fee types billed the same month) ->
 * nearest-preceding voucher_heads.id, since a voucher's heads are inserted
 * together in one createMany in the same order they were selected, so id
 * adjacency approximates "created alongside."
 */
function resolveDiscountGroup<T>(
    discount: OrderableHead<T>,
    discountAbsIndex: number | null,
    candidates: OrderableHead<T>[],
): number | typeof FALLBACK_GROUP_KEY {
    if (discountAbsIndex == null) return FALLBACK_GROUP_KEY;

    const matches = candidates.filter((c) => {
        if (c.isDiscount || c.feeTypeId == null) return false;
        return absIndexOf(c) === discountAbsIndex;
    });

    if (matches.length === 0) return FALLBACK_GROUP_KEY;
    if (matches.length === 1) return matches[0].feeTypeId as number;

    const discountId = discount.headId ?? Number.POSITIVE_INFINITY;
    const preceding = matches
        .filter((m) => (m.headId ?? Number.NEGATIVE_INFINITY) <= discountId)
        .sort((a, b) => (b.headId ?? 0) - (a.headId ?? 0));
    if (preceding.length > 0) return preceding[0].feeTypeId as number;

    const nearest = [...matches].sort(
        (a, b) => Math.abs((a.headId ?? 0) - discountId) - Math.abs((b.headId ?? 0) - discountId),
    );
    return nearest[0].feeTypeId as number;
}

/**
 * THE rule: group heads by fee type, order the groups by fee_types.priority_order,
 * order heads within a group by target month.
 *
 * `discountMatchCandidates` lets a caller pass a finer-grained pool than `items`
 * itself for resolving discount rows (e.g. pre-consolidation-range heads, so a
 * discount can match a month in the middle of a merged range).
 */
export function orderVoucherHeads<T>(
    items: OrderableHead<T>[],
    discountMatchCandidates?: OrderableHead<T>[],
): T[] {
    const candidates = discountMatchCandidates ?? items;

    const resolved: ResolvedHead<T>[] = items.map((item) => {
        const absIndex = absIndexOf(item);
        const groupKey: number | typeof FALLBACK_GROUP_KEY = item.isDiscount
            ? resolveDiscountGroup(item, absIndex, candidates)
            : item.feeTypeId ?? FALLBACK_GROUP_KEY;
        return { item, absIndex, groupKey, groupPriority: 0 };
    });

    const groups = new Map<number | typeof FALLBACK_GROUP_KEY, ResolvedHead<T>[]>();
    for (const r of resolved) {
        if (!groups.has(r.groupKey)) groups.set(r.groupKey, []);
        groups.get(r.groupKey)!.push(r);
    }

    const priorityOf = (key: number | typeof FALLBACK_GROUP_KEY, members: ResolvedHead<T>[]): number => {
        if (key === FALLBACK_GROUP_KEY) return Number.POSITIVE_INFINITY;
        const withPriority = members.find((m) => m.item.priorityOrder != null);
        return withPriority?.item.priorityOrder ?? 999;
    };

    const orderedGroupKeys = [...groups.keys()].sort((a, b) => {
        const pa = priorityOf(a, groups.get(a)!);
        const pb = priorityOf(b, groups.get(b)!);
        if (pa !== pb) return pa - pb;
        if (a === FALLBACK_GROUP_KEY) return 1;
        if (b === FALLBACK_GROUP_KEY) return -1;
        return (a as number) - (b as number);
    });

    const result: T[] = [];
    for (const key of orderedGroupKeys) {
        const members = groups.get(key)!;
        members.sort((a, b) => {
            const ia = a.absIndex ?? Number.POSITIVE_INFINITY;
            const ib = b.absIndex ?? Number.POSITIVE_INFINITY;
            if (ia !== ib) return ia - ib;
            if (a.item.isDiscount !== b.item.isDiscount) return a.item.isDiscount ? 1 : -1;
            return (a.item.headId ?? 0) - (b.item.headId ?? 0);
        });
        for (const m of members) result.push(m.item.ref);
    }
    return result;
}
