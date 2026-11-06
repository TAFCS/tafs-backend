import {
    FAMILY_CREDIT_KIND,
    assertCreditCovers,
    assertExcessClearsVoucher,
    assertHasFamily,
    creditReversalEntry,
    hasOpenCreditEntries,
    sumLedger,
} from './family-credit';

describe('family credit rules (TAFSD-421)', () => {
    describe('sumLedger', () => {
        it('the balance is the sum of the rows', () => {
            expect(sumLedger([{ amount: 35000 }, { amount: -20000 }, { amount: '5000.50' }]).toString()).toBe('20000.5');
        });
        it('an empty ledger is zero', () => {
            expect(sumLedger([]).toString()).toBe('0');
        });
    });

    describe('assertCreditCovers', () => {
        it('allows spending up to the balance exactly', () => {
            expect(() => assertCreditCovers(35000, 35000)).not.toThrow();
        });
        it('refuses to overdraw by even one rupee', () => {
            expect(() => assertCreditCovers(35000, 35001)).toThrow(/does not cover/);
        });
    });

    describe('assertHasFamily', () => {
        it('refuses a student with no family', () => {
            expect(() => assertHasFamily(null)).toThrow(/not linked to a family/);
        });
        it('accepts a family id', () => {
            expect(() => assertHasFamily(7)).not.toThrow();
        });
    });

    describe('assertExcessClearsVoucher', () => {
        it('allows an excess when the voucher is cleared', () => {
            expect(() => assertExcessClearsVoucher('PAID', 0)).not.toThrow();
        });
        it('refuses an excess on a voucher that is still part paid', () => {
            expect(() => assertExcessClearsVoucher('PARTIALLY_PAID', 0)).toThrow(/clears the whole voucher/);
        });
        it('refuses an excess while an overdue late fee is owed', () => {
            expect(() => assertExcessClearsVoucher('PAID', 1000)).toThrow(/including any late fee/);
        });
    });

    describe('creditReversalEntry', () => {
        it('a deposit with no credit entries needs nothing', () => {
            expect(creditReversalEntry(0, 5000)).toBeNull();
        });
        it('reversing an excess takes the credit back out', () => {
            const entry = creditReversalEntry(35000, 35000)!;
            expect(entry.amount.toString()).toBe('-35000');
            expect(entry.kind).toBe(FAMILY_CREDIT_KIND.EXCESS_REVERSED);
        });
        it('refuses to reverse an excess a sibling has already spent', () => {
            expect(() => creditReversalEntry(35000, 15000)).toThrow(/Reverse those deposits first/);
        });
        it('reversing a credit payment gives the credit back, whatever the balance', () => {
            const entry = creditReversalEntry(-20000, 0)!;
            expect(entry.amount.toString()).toBe('20000');
            expect(entry.kind).toBe(FAMILY_CREDIT_KIND.APPLICATION_REVERSED);
        });
    });

    describe('hasOpenCreditEntries', () => {
        it('false with no entries', () => {
            expect(hasOpenCreditEntries([])).toBe(false);
        });
        it('true while a deposit still has an entry standing', () => {
            expect(hasOpenCreditEntries([{ deposit_id: 1, amount: 35000 }])).toBe(true);
        });
        it('false once every entry has been undone', () => {
            expect(
                hasOpenCreditEntries([
                    { deposit_id: 1, amount: 35000 },
                    { deposit_id: 1, amount: -35000 },
                ]),
            ).toBe(false);
        });
    });
});
