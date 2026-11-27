import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';
import { formatEcVoucherNumber } from './ec-money.util';
import { recomputeVoucherInTx } from './ec-recompute';

/** The bank details printed on an EC challan, copied onto the voucher when it is issued. */
export interface EcBankSnapshot {
    id: number;
    name: string;
    title: string;
    account: string;
    iban: string;
    address: string;
}

/**
 * The bank to print: the one asked for (must exist and be active), else the
 * default active account, else the first active one. Copied, not linked, so a
 * later edit or delete of the bank record never changes or breaks a voucher.
 */
export async function resolveEcBank(prisma: Pick<PrismaClient, 'bank_accounts'> | Prisma.TransactionClient, bankAccountId?: number | null): Promise<EcBankSnapshot> {
    const select = { id: true, bank_name: true, account_title: true, account_number: true, iban: true, bank_address: true, is_active: true } as const;
    const bank = bankAccountId
        ? await prisma.bank_accounts.findUnique({ where: { id: bankAccountId }, select })
        : ((await prisma.bank_accounts.findFirst({ where: { is_active: true, is_default: true }, select })) ??
          (await prisma.bank_accounts.findFirst({ where: { is_active: true }, select, orderBy: { id: 'asc' } })));
    if (!bank) throw new BadRequestException(bankAccountId ? `Bank account #${bankAccountId} not found` : 'Add a bank account in School Setup → Banks first');
    if (bankAccountId && bank.is_active === false) throw new BadRequestException(`${bank.bank_name} (${bank.account_number}) is inactive`);
    return {
        id: bank.id,
        name: bank.bank_name,
        title: bank.account_title,
        account: bank.account_number,
        iban: bank.iban ?? '',
        address: bank.bank_address ?? '',
    };
}

export interface EcIssueInput {
    student: { cc: number; campus_id: number; class_id: number; section_id: number | null };
    academicYear: string;
    issueDate: Date;
    expiryDate: Date;
    bank: EcBankSnapshot;
    lines: { charge_id: number; description: string; amount: number; sort_order: number }[];
    /**
     * The voucher the charges must be on right now: null for a fresh issue
     * (they must be NOT_ISSUED), the old voucher's id for a reissue.
     */
    expectCurrentVoucherId: number | null;
    reissuedFromVoucherId?: number | null;
    createdBy: string;
    generatedByName: string;
    bulkRunId?: string | null;
}

/**
 * TAFSD-605: THE way an extracurricular voucher comes into being. Single issue,
 * bulk issue and reissue all go through here (no hand-kept duplicate, unlike
 * academic create()/splitPartiallyPaid()). It never touches any other voucher:
 * no arrears are pulled in and nothing is voided.
 *
 * The compare-and-set on current_voucher_id is what guarantees a charge sits on
 * one voucher at a time: if any charge moved since it was read, the count is
 * short and the whole transaction rolls back with a 409.
 */
export async function createVoucherInTx(tx: Prisma.TransactionClient, input: EcIssueInput): Promise<{ id: number; voucher_number: string }> {
    if (input.lines.length === 0) throw new BadRequestException('Pick at least one charge to put on the voucher');
    const total = input.lines.reduce((n, l) => n + l.amount, 0);
    if (input.lines.some((l) => !Number.isInteger(l.amount) || l.amount <= 0)) {
        throw new BadRequestException('Every charge on a voucher must owe a whole number of rupees above 0');
    }

    const voucher = await tx.ec_vouchers.create({
        data: {
            student_id: input.student.cc,
            campus_id: input.student.campus_id,
            class_id: input.student.class_id,
            section_id: input.student.section_id,
            academic_year: input.academicYear,
            issue_date: input.issueDate,
            expiry_date: input.expiryDate,
            status: 'UNPAID',
            total_amount: total,
            bank_account_id: input.bank.id,
            bank_snapshot: input.bank as unknown as Prisma.InputJsonValue,
            reissued_from_voucher_id: input.reissuedFromVoucherId ?? null,
            created_by: input.createdBy,
            generated_by_name: input.generatedByName,
            bulk_run_id: input.bulkRunId ?? null,
        },
        select: { id: true },
    });
    const voucher_number = formatEcVoucherNumber(voucher.id, input.issueDate);
    await tx.ec_vouchers.update({ where: { id: voucher.id }, data: { voucher_number } });

    await tx.ec_voucher_lines.createMany({
        data: input.lines.map((l) => ({
            voucher_id: voucher.id,
            charge_id: l.charge_id,
            description: l.description.slice(0, 150),
            amount: l.amount,
            sort_order: l.sort_order,
        })),
    });

    const moved = await tx.ec_student_charges.updateMany({
        where: {
            id: { in: input.lines.map((l) => l.charge_id) },
            current_voucher_id: input.expectCurrentVoucherId,
            ...(input.expectCurrentVoucherId == null ? { status: 'NOT_ISSUED' as const } : {}),
        },
        data: { current_voucher_id: voucher.id },
    });
    if (moved.count !== input.lines.length) {
        throw new ConflictException('Some of these charges were just put on another voucher. Reload and try again.');
    }

    await recomputeVoucherInTx(tx, voucher.id);
    return { id: voucher.id, voucher_number };
}
