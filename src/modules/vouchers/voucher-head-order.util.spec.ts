import { OrderableHead, orderVoucherHeads } from './voucher-head-order.util';

interface TestHead {
    label: string;
}

let nextId = 1;
function head(overrides: Partial<OrderableHead<TestHead>> & { label: string }): OrderableHead<TestHead> {
    return {
        ref: { label: overrides.label },
        headId: overrides.headId ?? nextId++,
        feeTypeId: overrides.feeTypeId ?? null,
        priorityOrder: overrides.priorityOrder ?? null,
        targetMonth: overrides.targetMonth ?? null,
        academicYear: overrides.academicYear ?? '2025-2026',
        term: overrides.term ?? {},
        isDiscount: overrides.isDiscount ?? false,
    };
}

function labelsOf(result: TestHead[]): string[] {
    return result.map((r) => r.label);
}

beforeEach(() => {
    nextId = 1;
});

describe('orderVoucherHeads', () => {
    it('groups by fee type and orders groups by priority_order', () => {
        const transport = head({ label: 'Transport', feeTypeId: 2, priorityOrder: 2, targetMonth: 8 });
        const tuition = head({ label: 'Tuition', feeTypeId: 1, priorityOrder: 1, targetMonth: 8 });

        const result = orderVoucherHeads([transport, tuition]);

        expect(labelsOf(result)).toEqual(['Tuition', 'Transport']);
    });

    it('sorts an arrear head sharing a fee type with a current head chronologically within the group', () => {
        const current = head({ label: 'Tuition Sep', feeTypeId: 1, priorityOrder: 1, targetMonth: 9 });
        const arrear = head({ label: 'Tuition Aug (arrear)', feeTypeId: 1, priorityOrder: 1, targetMonth: 8 });

        const result = orderVoucherHeads([current, arrear]);

        expect(labelsOf(result)).toEqual(['Tuition Aug (arrear)', 'Tuition Sep']);
    });

    it('attaches a discount to the fee-type group of the one real head matching its month', () => {
        const tuition = head({ label: 'Tuition', feeTypeId: 1, priorityOrder: 1, targetMonth: 9 });
        const transport = head({ label: 'Transport', feeTypeId: 2, priorityOrder: 2, targetMonth: 10 });
        const discount = head({ label: 'Discount', isDiscount: true, targetMonth: 9 });

        const result = orderVoucherHeads([tuition, transport, discount]);

        expect(labelsOf(result)).toEqual(['Tuition', 'Discount', 'Transport']);
    });

    it('sends a discount with zero month matches to the trailing fallback group', () => {
        const tuition = head({ label: 'Tuition', feeTypeId: 1, priorityOrder: 1, targetMonth: 9 });
        const discount = head({ label: 'Discount', isDiscount: true, targetMonth: 3 });

        const result = orderVoucherHeads([tuition, discount]);

        expect(labelsOf(result)).toEqual(['Tuition', 'Discount']);
    });

    it('resolves an ambiguous discount match (two fee types, same month) via nearest-preceding id', () => {
        const tuition = head({ label: 'Tuition', feeTypeId: 1, priorityOrder: 1, targetMonth: 9, headId: 10 });
        const transport = head({ label: 'Transport', feeTypeId: 2, priorityOrder: 2, targetMonth: 9, headId: 20 });
        const discount = head({ label: 'Discount', isDiscount: true, targetMonth: 9, headId: 21 });

        const result = orderVoucherHeads([tuition, transport, discount]);

        // headId 21 is preceded by transport's 20 (nearer than tuition's 10) -> joins Transport's group
        expect(labelsOf(result)).toEqual(['Tuition', 'Transport', 'Discount']);
    });

    it('falls back to priority 999 when priority_order is null', () => {
        const noPriority = head({ label: 'Misc', feeTypeId: 3, priorityOrder: null, targetMonth: 8 });
        const prioritized = head({ label: 'Tuition', feeTypeId: 1, priorityOrder: 1, targetMonth: 8 });

        const result = orderVoucherHeads([noPriority, prioritized]);

        expect(labelsOf(result)).toEqual(['Tuition', 'Misc']);
    });

    it('tie-breaks equal/duplicate priority_order by fee_type_id ascending', () => {
        const feeTypeFive = head({ label: 'FeeType5', feeTypeId: 5, priorityOrder: 1, targetMonth: 8 });
        const feeTypeTwo = head({ label: 'FeeType2', feeTypeId: 2, priorityOrder: 1, targetMonth: 8 });

        const result = orderVoucherHeads([feeTypeFive, feeTypeTwo]);

        expect(labelsOf(result)).toEqual(['FeeType2', 'FeeType5']);
    });
});
