import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';
import { StorageService } from '../../../common/storage/storage.service';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { EC_ALLOW_PAYMENT_AFTER_EXPIRY } from '../ec.constants';
import { actorNameOf, actorOf } from '../ec-common.util';
import { dateKey, parseDateKey, todayPktDate, todayPktKey } from '../ec-dates.util';
import { allocateAuto, remainingOf, validateManual } from '../ec-money.util';
import { lockEcVoucher, recomputeVoucherInTx } from '../ec-recompute';
import { EcVouchersService } from '../vouchers/ec-vouchers.service';
import { RecordEcDepositDto, ReverseEcDepositDto } from './dto/ec-deposits.dto';

/**
 * TAFSD-605: money received against extracurricular vouchers, recorded by
 * staff (desk or bank counter; EC is never paid online).
 *
 *   - One deposit pays one voucher, never more than its balance: no excess and
 *     no family credit.
 *   - It must be dated (the bank-stamp day) between the issue date and the
 *     valid-till date, and not in the future, so a challan the bank stamped
 *     before expiry can still be recorded after it.
 *   - Only the latest deposit on a voucher can be reversed, and reversal
 *     recomputes from the allocations that remain (recomputeVoucherInTx).
 *   - Every money change locks the voucher row first.
 */
@Injectable()
export class EcDepositsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly auditLogs: AuditLogsService,
        private readonly vouchers: EcVouchersService,
        private readonly storage: StorageService,
    ) {}

    async record(user: IJwtStaffPayload, dto: RecordEcDepositDto) {
        await this.vouchers.assertVisible(user, dto.voucher_id);
        const depositDate = dto.deposit_date ? parseDateKey(dto.deposit_date, 'Paid-on date') : todayPktDate();
        if (dateKey(depositDate) > todayPktKey()) throw new BadRequestException('The paid-on date is in the future');

        let depositId = 0;
        let voucherNumber = '';
        let studentId = 0;
        let split = new Map<number, number>();
        await this.prisma.$transaction(
            async (tx) => {
                await lockEcVoucher(tx, dto.voucher_id);
                const v = await tx.ec_vouchers.findUniqueOrThrow({
                    where: { id: dto.voucher_id },
                    select: {
                        id: true,
                        voucher_number: true,
                        student_id: true,
                        status: true,
                        issue_date: true,
                        expiry_date: true,
                        reissued_to: { select: { voucher_number: true } },
                        ec_voucher_lines: {
                            select: { id: true, charge_id: true, amount: true, amount_paid: true, waived_amount: true, ec_student_charges: { select: { current_voucher_id: true } } },
                            orderBy: { sort_order: 'asc' },
                        },
                    },
                });
                voucherNumber = v.voucher_number ?? String(v.id);
                studentId = v.student_id;
                if (v.status === 'PAID') throw new ConflictException(`${voucherNumber} is already paid`);
                if (v.status === 'WAIVED') throw new ConflictException(`${voucherNumber} is waived; nothing can be paid on it`);
                if (v.reissued_to) throw new ConflictException(`${voucherNumber} was reissued as ${v.reissued_to.voucher_number}; record the payment there`);
                if (depositDate < v.issue_date) throw new BadRequestException(`The paid-on date is before ${voucherNumber} was issued (${dateKey(v.issue_date)})`);
                if (!EC_ALLOW_PAYMENT_AFTER_EXPIRY && depositDate > v.expiry_date) {
                    throw new ConflictException(
                        `${voucherNumber} was valid till ${dateKey(v.expiry_date)}; a payment made on ${dateKey(depositDate)} can't be taken on it. Reissue the voucher.`,
                    );
                }
                if (v.ec_voucher_lines.some((l) => l.ec_student_charges.current_voucher_id !== v.id)) {
                    throw new ConflictException(`${voucherNumber} no longer bills all of its charges; reload and try again`);
                }

                const lines = v.ec_voucher_lines.map((l) => ({
                    id: l.id,
                    charge_id: l.charge_id,
                    remaining: remainingOf({ amount: Number(l.amount), amount_paid: Number(l.amount_paid), waived_amount: Number(l.waived_amount) }),
                }));
                split = dto.allocation === 'MANUAL' ? validateManual(lines, dto.lines ?? [], dto.amount) : allocateAuto(lines, dto.amount);
                const chargeOf = new Map(lines.map((l) => [l.id, l.charge_id]));

                const deposit = await tx.ec_deposits.create({
                    data: {
                        voucher_id: v.id,
                        student_id: v.student_id,
                        amount: dto.amount,
                        deposit_date: depositDate,
                        payment_method: dto.payment_method,
                        reference_number: dto.reference_number?.trim() || null,
                        bank_name: dto.bank_name?.trim() || null,
                        remarks: dto.remarks?.trim() || null,
                        recorded_by: actorOf(user),
                        recorded_by_name: actorNameOf(user),
                    },
                    select: { id: true },
                });
                depositId = deposit.id;
                await tx.ec_deposit_allocations.createMany({
                    data: [...split.entries()].map(([lineId, amount]) => ({ deposit_id: deposit.id, line_id: lineId, charge_id: chargeOf.get(lineId)!, amount })),
                });
                await recomputeVoucherInTx(tx, v.id);
            },
            { timeout: 20_000 },
        );

        await this.auditLogs.log({
            entity_type: 'EC_DEPOSIT',
            entity_id: String(depositId),
            action: 'CREATED',
            section: 'finance',
            student_id: studentId,
            new_value: JSON.stringify({
                voucher: voucherNumber,
                amount: dto.amount,
                method: dto.payment_method,
                paid_on: dateKey(depositDate),
                reference: dto.reference_number ?? null,
                split: Object.fromEntries(split),
            }),
            changed_by: actorOf(user),
        });
        return { deposit_id: depositId, voucher: await this.vouchers.detail(user, dto.voucher_id) };
    }

    async reverse(user: IJwtStaffPayload, depositId: number, dto: ReverseEcDepositDto) {
        const d = await this.prisma.ec_deposits.findUnique({
            where: { id: depositId },
            select: {
                id: true,
                voucher_id: true,
                student_id: true,
                amount: true,
                deposit_date: true,
                payment_method: true,
                reference_number: true,
                bank_name: true,
                remarks: true,
                recorded_by: true,
                created_at: true,
                ec_vouchers: { select: { voucher_number: true } },
                ec_deposit_allocations: { select: { line_id: true, charge_id: true, amount: true } },
            },
        });
        if (!d) throw new NotFoundException(`Extracurricular payment #${depositId} not found`);
        await this.vouchers.assertVisible(user, d.voucher_id);
        const reason = dto.reason.trim();
        if (reason.length < 3) throw new BadRequestException('Give a reason for reversing the payment');

        let cleared: string | null = null;
        await this.prisma.$transaction(
            async (tx) => {
                await lockEcVoucher(tx, d.voucher_id);
                const v = await tx.ec_vouchers.findUniqueOrThrow({
                    where: { id: d.voucher_id },
                    select: { status: true, voucher_number: true, reissued_to: { select: { voucher_number: true } } },
                });
                if (v.reissued_to) {
                    throw new ConflictException(`${v.voucher_number} was reissued as ${v.reissued_to.voucher_number}. Delete that voucher first (it must have no payments).`);
                }
                if (v.status === 'WAIVED') throw new ConflictException(`${v.voucher_number} is waived. Undo the waiver first.`);
                const latest = await tx.ec_deposits.findFirst({ where: { voucher_id: d.voucher_id }, orderBy: { id: 'desc' }, select: { id: true } });
                if (latest?.id !== depositId) throw new ConflictException('Only the latest payment on a voucher can be reversed. Reverse the newer one first.');
                await tx.ec_deposits.delete({ where: { id: depositId } });
                cleared = (await recomputeVoucherInTx(tx, d.voucher_id)).clearedPaidPdfUrl;
            },
            { timeout: 20_000 },
        );
        if (cleared) void this.storage.deleteByUrl(cleared);

        await this.auditLogs.log({
            entity_type: 'EC_DEPOSIT',
            entity_id: String(depositId),
            action: 'DELETED',
            section: 'finance',
            student_id: d.student_id,
            old_value: JSON.stringify({
                voucher: d.ec_vouchers.voucher_number,
                amount: Number(d.amount),
                method: d.payment_method,
                paid_on: dateKey(d.deposit_date),
                reference: d.reference_number,
                bank: d.bank_name,
                remarks: d.remarks,
                recorded_by: d.recorded_by,
                recorded_at: d.created_at,
                allocations: d.ec_deposit_allocations.map((a) => ({ line_id: a.line_id, charge_id: a.charge_id, amount: Number(a.amount) })),
            }),
            note: `Reversed: ${reason}`,
            changed_by: actorOf(user),
        });
        return this.vouchers.detail(user, d.voucher_id);
    }
}
