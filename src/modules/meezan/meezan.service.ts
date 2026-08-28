import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { MeezanBillInquiryDto } from './dto/bill-inquiry.dto';
import { MeezanBillPaymentDto } from './dto/bill-payment.dto';
import { Prisma, fee_status_enum } from '@prisma/client';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { VouchersService } from '../vouchers/vouchers.service';

@Injectable()
export class MeezanService {
  private readonly logger = new Logger(MeezanService.name);

  constructor(
    private prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly vouchersService: VouchersService,
  ) {}

  private validateAuth(serviceUserId: string, userPassword: string, billCompanyCode?: string) {
    if (
      serviceUserId !== process.env.MEEZAN_SERVICE_USER_ID ||
      userPassword !== process.env.MEEZAN_SERVICE_PASSWORD
    ) {
      return { ResponseCode: '094', ResponseDesc: 'User invalid' };
    }
    if (billCompanyCode !== undefined && billCompanyCode !== process.env.MEEZAN_COMPANY_CODE) {
      return { ResponseCode: '095', ResponseDesc: 'Company code mismatch' };
    }
    return null;
  }

  async handleBillInquiry(dto: MeezanBillInquiryDto) {
    try {
      const authError = this.validateAuth(dto.ServiceUserId, dto.UserPassword, dto.BillCompanyCode);
      if (authError) return authError;

      let voucher = await this.prisma.vouchers.findFirst({
        where: { voucher_number: dto.VoucherNumber },
        include: {
          students: true,
          voucher_arrear_surcharges: true,
        },
      });

      // Fallback: old vouchers have voucher_number = NULL; extract id from last 7 digits
      if (!voucher && dto.VoucherNumber.length === 11) {
        const fallbackId = parseInt(dto.VoucherNumber.slice(4), 10);
        if (!isNaN(fallbackId)) {
          voucher = await this.prisma.vouchers.findFirst({
            where: { id: fallbackId },
            include: {
              students: true,
              voucher_arrear_surcharges: true,
            },
          });
        }
      }

      if (!voucher) {
        return { ResponseCode: '091', ResponseDesc: 'Voucher Id is invalid' };
      }

      const today = new Date();
      const dueDate = voucher.due_date;
      const validityDate = voucher.validity_date;

      if (voucher.status === 'VOID') {
        return { ResponseCode: '093', ResponseDesc: 'Voucher is void' };
      }

      if (voucher.status === 'PAID') {
        return { ResponseCode: '097', ResponseDesc: 'Voucher is already paid' };
      }

      if (validityDate && today > validityDate) {
        return { ResponseCode: '092', ResponseDesc: 'Voucher date is expired' };
      }

      const amountWIDDate = Number(voucher.total_payable_before_due || 0);
      const amountADDate = Number(voucher.total_payable_after_due || 0);

      const tNormalized = new Date(today);
      tNormalized.setHours(0, 0, 0, 0);
      const dNormalized = new Date(dueDate);
      dNormalized.setHours(0, 0, 0, 0);
      const isOverdue = tNormalized > dNormalized;

      const remarks = voucher.surcharge_waived
        ? 'Surcharge waived'
        : isOverdue
          ? 'Late payment surcharge applies'
          : '';

      let yymm = '0000';
      if (voucher.month && voucher.academic_year) {
        const yearPart = voucher.academic_year.split('-')[0];
        const yy = yearPart.slice(-2);
        const mm = String(voucher.month).padStart(2, '0');
        yymm = `${yy}${mm}`;
      }

      return {
        StatusCode: '00',
        StatusDesc: 'Unpaid',
        student_name: voucher.students.full_name,
        student_id: String(voucher.students.cc),
        due_date: dueDate.toISOString().slice(0, 10).replace(/-/g, ''), // yyyymmdd
        Amount_WID_Date: String(amountWIDDate),
        Amount_AD_Date: String(amountADDate),
        BillingMonth: yymm,
        Remarks: remarks,
      };
    } catch (err) {
      this.logger.error('Bill inquiry error', err);
      return { ResponseCode: '096', ResponseDesc: 'General exception' };
    }
  }

  async handleBillPayment(dto: MeezanBillPaymentDto) {
    try {
      const authError = this.validateAuth(dto.ServiceUserId, dto.UserPassword, dto.BillCompanyCode);
      if (authError) return authError;

      let voucher = await this.prisma.vouchers.findFirst({
        where: { voucher_number: dto.VoucherNumber },
        include: {
          voucher_heads: { include: { student_fees: true } },
          voucher_arrear_surcharges: true,
        },
      });

      // Fallback: old vouchers have voucher_number = NULL; extract id from last 7 digits
      if (!voucher && dto.VoucherNumber.length === 11) {
        const fallbackId = parseInt(dto.VoucherNumber.slice(4), 10);
        if (!isNaN(fallbackId)) {
          voucher = await this.prisma.vouchers.findFirst({
            where: { id: fallbackId },
            include: {
              voucher_heads: { include: { student_fees: true } },
              voucher_arrear_surcharges: true,
            },
          });
        }
      }

      if (!voucher) {
        return { ResponseCode: '091', ResponseDesc: 'Voucher Id is invalid' };
      }

      const transDateStr = dto.TransDate;
      const today = new Date(
        `${transDateStr.slice(0, 4)}-${transDateStr.slice(4, 6)}-${transDateStr.slice(6, 8)}`,
      );
      const validityDate = voucher.validity_date;

      if (voucher.status === 'PAID') {
        return { ResponseCode: '097', ResponseDesc: 'Voucher already paid' };
      }

      if (validityDate && today > validityDate) {
        return { ResponseCode: '092', ResponseDesc: 'Voucher date is expired' };
      }

      if (dto.Status !== 'C') {
        const returnNote =
          dto.Status === 'R' && dto.ReasonDescription
            ? `Returned — ${dto.ReasonCode}: ${dto.ReasonDescription}`
            : 'Lodged/Returned — not posted';
        this.logger.log(`Voucher ${voucher.id} (${dto.VoucherNumber}) not posted: ${returnNote}`);
        return { StatusCode: '00', StatusDesc: 'Lodged/Returned — not posted' };
      }

      // Every deposit collected through the Meezan Bank integration is booked
      // under the dedicated `meezan` method — it is the collection channel, not
      // a cheque handed to the school. The instrument the payer actually used at
      // the branch (dto.PaymentMode: CASH / CHQ / ONLINE …) is kept in remarks
      // for reconciliation.
      const modeNote = dto.PaymentMode
        ? `Meezan Bank — ${dto.PaymentMode}`
        : 'Meezan Bank payment';
      const remarks = dto.ChequeNo ? `${modeNote} (CHQ: ${dto.ChequeNo})` : modeNote;

      const dateOfReturn = dto.DateOfReturn
        ? new Date(
            `${dto.DateOfReturn.slice(0, 4)}-${dto.DateOfReturn.slice(4, 6)}-${dto.DateOfReturn.slice(6, 8)}`,
          )
        : null;

      await this.prisma.$transaction(async (tx) => {
        const deposit = await tx.deposits.create({
          data: {
            student_id: voucher.student_id,
            total_amount: Number(dto.TransAmount),
            deposit_date: today,
            payment_method: 'meezan',
            reference_number: dto.TransAuthenticationCode,
            remarks,
            bank_code: dto.BankCode,
            bank_name: dto.BankName,
            date_of_return: dateOfReturn,
          },
        });

        // Cap what gets credited by what the bank actually collected
        // (dto.TransAmount) — this used to blindly pay off every head's full
        // balance regardless of the transferred amount, which also meant a
        // discount-bearing voucher had its discount's own positive `amount`
        // auto-collected as if it were real fee cash. The gap left by an
        // attached discount is closed below via applyDiscountCreditInTx,
        // the same helper VouchersService.recordDeposit uses.
        let pool = new Prisma.Decimal(dto.TransAmount);
        const touchedHeadIds: number[] = [];

        for (const head of voucher.voucher_heads) {
          if (head.student_fees.is_discount) continue; // never auto-collect a discount head as cash
          if (pool.lte(0)) break;

          const headBalance = new Prisma.Decimal(head.student_fees.amount ?? 0).sub(
            new Prisma.Decimal(head.student_fees.amount_paid ?? 0),
          );
          if (headBalance.lte(0)) continue;

          const toApply = Prisma.Decimal.min(pool, headBalance);
          if (toApply.lte(0)) continue;

          await tx.deposit_allocations.create({
            data: {
              deposit_id: deposit.id,
              student_fee_id: head.student_fee_id,
              voucher_id: voucher.id,
              amount: toApply,
              type: 'FEE_HEAD',
            },
          });

          const totalPaid = new Prisma.Decimal(head.student_fees.amount_paid ?? 0).add(toApply);
          await tx.student_fees.update({
            where: { id: head.student_fee_id },
            data: {
              amount_paid: totalPaid,
              status: toApply.eq(headBalance) ? fee_status_enum.PAID : fee_status_enum.PARTIALLY_PAID,
            },
          });

          const newDeposited = new Prisma.Decimal(head.amount_deposited ?? 0).add(toApply);
          await tx.voucher_heads.update({
            where: { id: head.id },
            data: {
              amount_deposited: newDeposited,
              balance: Prisma.Decimal.max(
                new Prisma.Decimal(head.net_amount ?? 0).sub(newDeposited),
                new Prisma.Decimal(0),
              ),
            },
          });

          touchedHeadIds.push(head.id);
          pool = pool.sub(toApply);
        }

        // Surcharges exist because of an OLDER unpaid month, not because this
        // voucher itself is overdue — they're already baked into the amount the
        // bank quoted and collected (total_payable_before_due), so they must
        // always be settled here regardless of isOverdue. Gating this on
        // isOverdue let the bank collect the surcharge cash while the system
        // kept recording it as unpaid. Also capped by the same pool as heads.
        const surcharges = voucher.voucher_arrear_surcharges.filter((s) => !s.waived);
        for (const s of surcharges) {
          if (pool.lte(0)) break;
          const sBalance = new Prisma.Decimal(s.amount).sub(new Prisma.Decimal(s.amount_paid ?? 0));
          if (sBalance.lte(0)) continue;
          const toApply = Prisma.Decimal.min(pool, sBalance);
          if (toApply.lte(0)) continue;

          await tx.deposit_allocations.create({
            data: {
              deposit_id: deposit.id,
              voucher_id: voucher.id,
              surcharge_id: s.id,
              amount: toApply,
              type: 'SURCHARGE',
            },
          });

          await tx.voucher_arrear_surcharges.update({
            where: { id: s.id },
            data: { amount_paid: { increment: toApply } },
          });

          pool = pool.sub(toApply);
        }

        // Close any remaining shortfall (typically exactly the size of an
        // attached discount) via discount credit, same as a manual deposit.
        if (touchedHeadIds.length > 0) {
          await this.vouchersService.applyDiscountCreditInTx(
            tx,
            voucher.id,
            touchedHeadIds,
            deposit.id,
          );
        }

        // Recompute status from what's actually left, instead of assuming the
        // bank's transaction always covers the voucher in full.
        const refreshedHeads = await tx.voucher_heads.findMany({ where: { voucher_id: voucher.id } });
        const remainingHeads = refreshedHeads.reduce(
          (sum, h) => sum.add(new Prisma.Decimal(h.balance ?? 0)),
          new Prisma.Decimal(0),
        );
        const refreshedSurcharges = await (tx as any).voucher_arrear_surcharges.findMany({
          where: { voucher_id: voucher.id, waived: false },
        });
        const remainingSurcharges = refreshedSurcharges.reduce(
          (sum: Prisma.Decimal, s: any) =>
            sum.add(new Prisma.Decimal(s.amount).sub(new Prisma.Decimal(s.amount_paid ?? 0))),
          new Prisma.Decimal(0),
        );
        const anyDeposited =
          refreshedHeads.some((h) => new Prisma.Decimal(h.amount_deposited ?? 0).gt(0)) ||
          refreshedSurcharges.some((s: any) => new Prisma.Decimal(s.amount_paid ?? 0).gt(0));

        const nextStatus =
          remainingHeads.lte(0) && remainingSurcharges.lte(0)
            ? 'PAID'
            : anyDeposited
              ? 'PARTIALLY_PAID'
              : voucher.status;

        await tx.vouchers.update({
          where: { id: voucher.id },
          data: { status: nextStatus },
        });
      });

      await this.auditLogs.log({
        entity_type: 'VOUCHER',
        entity_id: String(voucher.id),
        action: 'UPDATED',
        field: 'status',
        old_value: voucher.status,
        new_value: 'PAID',
        changed_by: 'meezan-bank',
        student_id: voucher.student_id,
        note: [
          `Meezan bill payment posted for voucher #${voucher.id}.`,
          `Amount=Rs. ${dto.TransAmount}`,
          `Consumer/voucher no=${dto.VoucherNumber}`,
          `Payment ref=${dto.TransAuthenticationCode}`,
          `Method=meezan`,
          `Bank mode=${dto.PaymentMode}`,
        ].join(' | '),
      });

      return { StatusCode: '00', StatusDesc: 'Success' };
    } catch (err) {
      this.logger.error('Bill payment error', err);
      return { ResponseCode: '096', ResponseDesc: 'General exception' };
    }
  }
}
