import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { MeezanBillInquiryDto } from './dto/bill-inquiry.dto';
import { MeezanBillPaymentDto } from './dto/bill-payment.dto';
import { fee_status_enum } from '@prisma/client';

@Injectable()
export class MeezanService {
  private readonly logger = new Logger(MeezanService.name);

  constructor(private prisma: PrismaService) {}

  private validateAuth(serviceUserId: string, userPassword: string, billCompanyCode: string) {
    if (
      serviceUserId !== process.env.MEEZAN_SERVICE_USER_ID ||
      userPassword !== process.env.MEEZAN_SERVICE_PASSWORD
    ) {
      return { ResponseCode: '094', ResponseDesc: 'User invalid' };
    }
    if (billCompanyCode !== process.env.MEEZAN_COMPANY_CODE) {
      return { ResponseCode: '095', ResponseDesc: 'Company code mismatch' };
    }
    return null;
  }

  async handleBillInquiry(dto: MeezanBillInquiryDto) {
    try {
      const authError = this.validateAuth(dto.ServiceUserId, dto.UserPassword, dto.BillCompanyCode);
      if (authError) return authError;

      const voucher = await this.prisma.vouchers.findFirst({
        where: { voucher_number: dto.VoucherNumber },
        include: {
          students: true,
          voucher_arrear_surcharges: true,
        },
      });

      if (!voucher) {
        return { ResponseCode: '091', ResponseDesc: 'Voucher Id is invalid' };
      }

      const today = new Date();
      const dueDate = voucher.due_date;
      const validityDate = voucher.validity_date;

      if (voucher.status === 'PAID') {
        return { StatusCode: '097', StatusDesc: 'Already Paid', ResponseDesc: 'Voucher is already paid' };
      }

      if (validityDate && today > validityDate) {
        return { ResponseCode: '092', ResponseDesc: 'Voucher date is expired' };
      }

      const amountWIDDate = Number(voucher.total_payable_before_due || 0);
      const tNormalized = new Date(today);
      tNormalized.setHours(0, 0, 0, 0);
      const dNormalized = new Date(dueDate);
      dNormalized.setHours(0, 0, 0, 0);
      const amountADDate = tNormalized > dNormalized ? amountWIDDate + 1000 : amountWIDDate;

      // BillingMonth: yymm from academic_year + month
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

      const voucher = await this.prisma.vouchers.findFirst({
        where: { voucher_number: dto.VoucherNumber },
        include: {
          voucher_heads: { include: { student_fees: true } },
          voucher_arrear_surcharges: true,
        },
      });

      if (!voucher) {
        return { ResponseCode: '091', ResponseDesc: 'Voucher Id is invalid' };
      }

      // Parse TransDate (yyyymmdd -> Date)
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

      // If Lodged or Returned — do not post, return 00 with note
      if (dto.Status !== 'C') {
        const returnNote =
          dto.Status === 'R' && dto.ReasonDescription
            ? `Returned — ${dto.ReasonCode}: ${dto.ReasonDescription}`
            : 'Lodged/Returned — not posted';
        this.logger.log(`Voucher ${voucher.id} (${dto.VoucherNumber}) not posted: ${returnNote}`);
        return { StatusCode: '00', StatusDesc: 'Lodged/Returned — not posted' };
      }

      const tNormalized = new Date(today);
      tNormalized.setHours(0, 0, 0, 0);
      const dNormalized = new Date(voucher.due_date);
      dNormalized.setHours(0, 0, 0, 0);
      const isOverdue = tNormalized > dNormalized;
      const remarks = dto.ChequeNo ? `CHQ: ${dto.ChequeNo}` : 'Meezan Bank payment';

      await this.prisma.$transaction(async (tx) => {
        // 1. Create deposit
        const deposit = await tx.deposits.create({
          data: {
            student_id: voucher.student_id,
            total_amount: Number(dto.TransAmount),
            deposit_date: today,
            payment_method: dto.PaymentMode,
            reference_number: dto.TransAuthenticationCode,
            remarks,
          },
        });

        // 2. Allocate to each voucher head fully
        for (const head of voucher.voucher_heads) {
          const headBalance =
            Number(head.student_fees.amount) - Number(head.student_fees.amount_paid);
          if (headBalance <= 0) continue;

          await tx.deposit_allocations.create({
            data: {
              deposit_id: deposit.id,
              student_fee_id: head.student_fee_id,
              voucher_id: voucher.id,
              amount: headBalance,
              type: 'FEE',
            },
          });

          await tx.student_fees.update({
            where: { id: head.student_fee_id },
            data: {
              amount_paid: { increment: headBalance },
              status: fee_status_enum.PAID,
            },
          });
        }

        // 3. If overdue, allocate LPS against voucher_arrear_surcharges
        if (isOverdue) {
          const surcharges = voucher.voucher_arrear_surcharges.filter((s) => !s.waived);
          for (const s of surcharges) {
            const sBalance = Number(s.amount) - Number(s.amount_paid);
            if (sBalance <= 0) continue;

            await tx.deposit_allocations.create({
              data: {
                deposit_id: deposit.id,
                voucher_id: voucher.id,
                surcharge_id: s.id,
                amount: sBalance,
                type: 'SURCHARGE',
              },
            });

            await tx.voucher_arrear_surcharges.update({
              where: { id: s.id },
              data: { amount_paid: { increment: sBalance } },
            });
          }
        }

        // 4. Mark voucher PAID
        await tx.vouchers.update({
          where: { id: voucher.id },
          data: { status: 'PAID' },
        });
      });

      return { StatusCode: '00', StatusDesc: 'Success' };
    } catch (err) {
      this.logger.error('Bill payment error', err);
      return { ResponseCode: '096', ResponseDesc: 'General exception' };
    }
  }
}
