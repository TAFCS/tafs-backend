import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { timingSafeEqual } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { VouchersService } from '../vouchers/vouchers.service';
import { ccFromUblConsumerNumber, isUbl1BillConsumerNumber, ubl1BillCharge, ubl1BillConsumerNumber, ublCc } from '../../utils/ubl.util';
import { UblBillInquiryQueryDto, UblBillPaymentDto } from './dto/ubl-bill.dto';

/**
 * Response codes returned to UBL in `response_code` (HTTP is always 200 for a
 * well-formed, authenticated request). Documented in the TAFS API
 * Documentation for UBL — change both together.
 */
export const UBL_RESPONSE = {
    OK: ['00', 'Success'],
    CONSUMER_NOT_FOUND: ['01', 'Consumer number not found'],
    NO_VOUCHER: ['02', 'No voucher has been issued for this student'],
    ALREADY_PAID: ['03', 'Voucher is already paid'],
    EXPIRED: ['04', 'Voucher validity has expired; a new voucher must be issued by the school'],
    NOT_PAYABLE: ['05', 'Voucher is not payable (cancelled or written off)'],
    AMOUNT_MISMATCH: ['06', 'Amount does not match the payable amount'],
    VOUCHER_CHANGED: ['07', 'A newer voucher has been issued; inquire again'],
    DUPLICATE: ['08', 'Duplicate transaction; already posted'],
    INVALID_REQUEST: ['09', 'Invalid request'],
    UNAUTHORIZED: ['10', 'Invalid credentials'],
    GENERAL_ERROR: ['99', 'General error; retry later'],
} as const;

type ResponseKey = keyof typeof UBL_RESPONSE;
const reply = (key: ResponseKey, extra: Record<string, unknown> = {}) => ({
    response_code: UBL_RESPONSE[key][0],
    response_desc: UBL_RESPONSE[key][1],
    ...extra,
});

const PAYMENT_METHOD_LABEL = 'ubl';
const AUDIT_ACTOR = 'ubl-bank';

/** YYYY-MM-DD of an instant in Pakistan time — vouchers' due/validity dates are calendar dates. */
function pktDate(d: Date): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(d);
}

function dateOnly(d: Date | null | undefined): string | null {
    return d ? new Date(d).toISOString().slice(0, 10) : null;
}

const toYmd = (iso: string | null) => (iso ? iso.replace(/-/g, '') : null);

@Injectable()
export class UblService {
    private readonly logger = new Logger(UblService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly auditLogs: AuditLogsService,
        private readonly vouchersService: VouchersService,
    ) {}

    /** Credentials come in the X-UBL-User / X-UBL-Password headers (never in the URL). */
    isAuthorized(user?: string, password?: string): boolean {
        const expectedUser = process.env.UBL_SERVICE_USER_ID;
        const expectedPass = process.env.UBL_SERVICE_PASSWORD;
        if (!expectedUser || !expectedPass || !user || !password) return false;
        const same = (a: string, b: string) =>
            a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
        return same(user, expectedUser) && same(password, expectedPass);
    }

    /**
     * The student's most recent live voucher: newest by id, skipping VOID
     * (superseded) vouchers and ones still held for release (parents can't see
     * them yet). TAFS has agreed that search by CC always resolves to this one.
     */
    private async latestVoucherId(cc: number): Promise<number | null> {
        const live = { student_id: cc, status: { not: 'VOID' }, released_to_parent_at: { not: null } };
        // With more than one active voucher, the most recent still-payable one is
        // presented first; the older one comes up once that is settled.
        const payable = await this.prisma.vouchers.findFirst({
            where: { ...live, status: { in: ['UNPAID', 'OVERDUE', 'PARTIALLY_PAID'] } },
            orderBy: { id: 'desc' },
            select: { id: true },
        });
        if (payable) return payable.id;
        // Nothing payable: the newest live voucher, so UBL is told why (paid / expired / written off).
        const v = await this.prisma.vouchers.findFirst({ where: live, orderBy: { id: 'desc' }, select: { id: true } });
        return v?.id ?? null;
    }

    /**
     * What the voucher still needs, from the same normalised view the deposit
     * screen uses: heads net of any unapplied discount, unpaid arrear
     * surcharges, and the unpaid due-date late fee.
     */
    private payable(voucher: any, onDate: string) {
        const headsNet = Prisma.Decimal.max(
            new Prisma.Decimal(voucher.head_balance ?? 0).sub(new Prisma.Decimal(voucher.total_discount_unapplied ?? 0)),
            new Prisma.Decimal(0),
        );
        const surcharges = new Prisma.Decimal(voucher.surcharge_balance ?? 0);
        const totalLateFee = voucher.late_fee_charge
            ? Prisma.Decimal.max(
                new Prisma.Decimal(voucher.total_payable_after_due ?? 0).sub(new Prisma.Decimal(voucher.total_payable_before_due ?? 0)),
                new Prisma.Decimal(0),
            )
            : new Prisma.Decimal(0);
        const lateFee = Prisma.Decimal.max(
            totalLateFee.sub(new Prisma.Decimal(voucher.late_fee_deposited ?? 0)),
            new Prisma.Decimal(0),
        );
        const withinDue = headsNet.add(surcharges);
        const afterDue = withinDue.add(lateFee);
        const due = dateOnly(voucher.due_date);
        const overdue = due != null && onDate > due;
        return { headsNet, surcharges, lateFee, withinDue, afterDue, overdue, payableNow: overdue ? afterDue : withinDue };
    }

    /** Resolves consumer number → student → latest voucher, or a ready error reply. */
    private async resolve(consumerNumber: string, onDate: string) {
        const cc = ccFromUblConsumerNumber(consumerNumber);
        if (cc == null) return { error: reply('CONSUMER_NOT_FOUND') };
        const student = await this.prisma.students.findUnique({
            where: { cc },
            select: { cc: true, full_name: true, gr_number: true, campuses: { select: { campus_name: true } }, classes: { select: { description: true } } },
        });
        if (!student) return { error: reply('CONSUMER_NOT_FOUND') };

        const voucherId = await this.latestVoucherId(cc);
        if (!voucherId) return { error: reply('NO_VOUCHER') };
        const voucher: any = await this.vouchersService.findOne(voucherId);
        if (!voucher) return { error: reply('NO_VOUCHER') };

        if (voucher.status === 'PAID') return { error: reply('ALREADY_PAID', { voucher_number: voucher.voucher_number }) };
        if (voucher.status === 'WAIVED') return { error: reply('NOT_PAYABLE', { voucher_number: voucher.voucher_number }) };
        const validity = dateOnly(voucher.validity_date);
        if (voucher.status === 'EXPIRED' || (validity && onDate > validity)) {
            return { error: reply('EXPIRED', { voucher_number: voucher.voucher_number }) };
        }
        return { cc, student, voucher };
    }

    async billInquiry(dto: UblBillInquiryQueryDto) {
        try {
            const today = pktDate(new Date());
            const r = await this.resolve(dto.consumer_number, today);
            if ('error' in r) return r.error;
            const { cc, student, voucher } = r;
            const p = this.payable(voucher, today);
            if (p.withinDue.lte(0)) return reply('ALREADY_PAID', { voucher_number: voucher.voucher_number });
            // A 15-digit 1Bill number is quoted the bill + the 1Bill charge; a CC the bill alone.
            const oneBill = isUbl1BillConsumerNumber(dto.consumer_number);
            const withCharge = (amount: Prisma.Decimal) => {
                const bill = Number(amount.toFixed(2));
                const charge = oneBill ? ubl1BillCharge(bill) : 0;
                return { amount: Number(amount.add(charge).toFixed(2)), charge };
            };
            const within = withCharge(p.withinDue);
            const after = withCharge(p.afterDue);
            const now = p.overdue ? after : within;

            return reply('OK', {
                consumer_number: dto.consumer_number,
                onebill_consumer_number: ubl1BillConsumerNumber(cc),
                cc: ublCc(cc),
                student_name: student.full_name,
                gr_number: student.gr_number ?? null,
                campus: student.campuses?.campus_name ?? null,
                class: student.classes?.description ?? null,
                voucher_number: voucher.voucher_number,
                billing_month: voucher.months_label ?? null,
                voucher_status: voucher.status,
                issue_date: toYmd(dateOnly(voucher.issue_date)),
                due_date: toYmd(dateOnly(voucher.due_date)),
                validity_date: toYmd(dateOnly(voucher.validity_date)),
                currency: 'PKR',
                amount_within_due_date: within.amount,
                amount_after_due_date: after.amount,
                late_fee: Number(p.lateFee.toFixed(2)),
                channel_fee: now.charge,
                amount_payable: now.amount,
            });
        } catch (err) {
            this.logger.error('UBL bill inquiry error', err as any);
            return reply('GENERAL_ERROR');
        }
    }

    async billPayment(dto: UblBillPaymentDto) {
        try {
            if ((dto.payment_method === 'CHEQUE' || dto.payment_method === 'PAY_ORDER') && !dto.instrument_number) {
                return reply('INVALID_REQUEST', { response_desc: 'instrument_number is required for CHEQUE and PAY_ORDER' });
            }

            // The consumer number decides 1Bill; channel only splits CC payments by where they came in.
            const oneBill = isUbl1BillConsumerNumber(dto.consumer_number);
            if (oneBill && dto.channel && dto.channel !== 'ONEBILL') {
                return reply('INVALID_REQUEST', { response_desc: 'A 1Bill consumer number is always channel ONEBILL' });
            }
            if (!oneBill && (!dto.channel || dto.channel === 'ONEBILL')) {
                return reply('INVALID_REQUEST', { response_desc: 'channel is required for a CC: OTC, APP or INTERNET_BANKING' });
            }
            const channel = oneBill ? 'ONEBILL' : dto.channel!;

            // Idempotent on UBL's transaction id: a retry after a timeout never books twice.
            const existing = await this.prisma.deposits.findFirst({
                where: { payment_method: PAYMENT_METHOD_LABEL, reference_number: dto.transaction_id },
                select: { id: true },
            });
            if (existing) return reply('DUPLICATE', { transaction_id: dto.transaction_id, tafs_receipt_id: String(existing.id) });

            const txnAt = new Date(dto.transaction_datetime);
            const txnDate = pktDate(txnAt);
            const r = await this.resolve(dto.consumer_number, txnDate);
            if ('error' in r) return r.error;
            const { cc, voucher } = r;
            if (dto.voucher_number && dto.voucher_number !== voucher.voucher_number) {
                return reply('VOUCHER_CHANGED', { voucher_number: voucher.voucher_number });
            }

            const p = this.payable(voucher, txnDate);
            if (p.payableNow.lte(0)) return reply('ALREADY_PAID', { voucher_number: voucher.voucher_number });
            const channelFee = new Prisma.Decimal(oneBill ? ubl1BillCharge(Number(p.payableNow.toFixed(2))) : 0);
            const expected = p.payableNow.add(channelFee);
            const received = new Prisma.Decimal(dto.amount);
            if (!received.eq(expected)) {
                return reply('AMOUNT_MISMATCH', { amount_payable: Number(expected.toFixed(2)) });
            }

            // Book only the fee amount — the 1Bill fee is 1Bill's, noted on the deposit.
            const booked = p.payableNow;
            const lateFee = p.overdue ? p.lateFee : new Prisma.Decimal(0);
            const surchargeAllocations = (voucher.voucher_arrear_surcharges ?? [])
                .filter((s: any) => !s.waived)
                .map((s: any) => ({
                    surcharge_id: s.id,
                    amount: Number(Prisma.Decimal.max(new Prisma.Decimal(s.amount).sub(new Prisma.Decimal(s.amount_paid ?? 0)), new Prisma.Decimal(0)).toFixed(2)),
                }))
                .filter((s: any) => s.amount > 0);

            // Heads take what's left, in the voucher's own head order; any gap an
            // attached discount leaves is closed by recordDeposit's discount credit.
            let pool = booked.sub(lateFee).sub(p.surcharges);
            const distributions: Record<string, number> = {};
            for (const h of voucher.voucher_heads ?? []) {
                if (pool.lte(0)) break;
                if (h.student_fees?.is_discount || h.waived || h.student_fees?.status === 'WAIVED') continue;
                const bal = new Prisma.Decimal(h.balance ?? 0);
                if (bal.lte(0)) continue;
                const take = Prisma.Decimal.min(pool, bal);
                distributions[String(h.id)] = Number(take.toFixed(2));
                pool = pool.sub(take);
            }

            const methodNote = [
                `UBL ${channel}`,
                dto.payment_method,
                dto.instrument_number ? `instrument ${dto.instrument_number}` : null,
                dto.branch_code ? `branch ${dto.branch_code}` : null,
                channelFee.gt(0) ? `1Bill fee PKR ${channelFee.toFixed(0)} (not booked)` : null,
            ].filter(Boolean).join(' · ');

            await this.vouchersService.recordDeposit(
                voucher.id,
                {
                    amount: Number(booked.toFixed(2)),
                    distributions,
                    late_fee: lateFee.gt(0) ? Number(lateFee.toFixed(2)) : undefined,
                    surcharge_allocations: surchargeAllocations.length ? surchargeAllocations : undefined,
                    payment_method: PAYMENT_METHOD_LABEL,
                    reference_number: dto.transaction_id,
                } as any,
                AUDIT_ACTOR,
            );

            const deposit = await this.prisma.deposits.findFirst({
                where: { payment_method: PAYMENT_METHOD_LABEL, reference_number: dto.transaction_id, student_id: cc },
                orderBy: { id: 'desc' },
                select: { id: true },
            });
            if (deposit) {
                await this.prisma.deposits.update({
                    where: { id: deposit.id },
                    data: {
                        deposit_date: txnAt,
                        remarks: methodNote,
                        bank_code: dto.payer_bank_code ?? null,
                        bank_name: dto.payer_bank_name ?? (oneBill ? null : 'UBL'),
                    },
                });
            }

            await this.auditLogs.log({
                entity_type: 'VOUCHER',
                entity_id: String(voucher.id),
                action: 'UPDATED',
                field: 'status',
                old_value: voucher.status,
                new_value: 'PAID',
                changed_by: AUDIT_ACTOR,
                student_id: cc,
                note: [
                    `UBL bill payment posted for voucher #${voucher.id}.`,
                    `Booked=Rs. ${booked.toFixed(0)}`,
                    `Received=Rs. ${received.toFixed(0)}`,
                    `Channel=${channel}`,
                    `Method=${dto.payment_method}`,
                    `Txn=${dto.transaction_id}`,
                ].join(' | '),
            });

            return reply('OK', {
                transaction_id: dto.transaction_id,
                tafs_receipt_id: deposit ? String(deposit.id) : null,
                voucher_number: voucher.voucher_number,
                amount_booked: Number(booked.toFixed(2)),
                channel_fee: Number(channelFee.toFixed(2)),
            });
        } catch (err) {
            this.logger.error('UBL bill payment error', err as any);
            return reply('GENERAL_ERROR');
        }
    }
}

