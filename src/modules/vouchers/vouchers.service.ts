import { Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateVoucherDto } from './dto/create-voucher.dto';
import { UpdateVoucherDto } from './dto/update-voucher.dto';
import { StorageService } from '../../common/storage/storage.service';

const VOUCHER_INCLUDE = {
    students: {
        select: { cc: true, full_name: true, gr_number: true },
    },
    campuses: {
        select: { id: true, campus_name: true },
    },
    classes: {
        select: { id: true, description: true },
    },
    sections: {
        select: { id: true, description: true },
    },
    bank_accounts: {
        select: { id: true, bank_name: true, account_title: true, account_number: true, branch_code: true, bank_address: true, iban: true },
    },
};

@Injectable()
export class VouchersService {
    private readonly logger = new Logger(VouchersService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly storage: StorageService,
    ) {}

    async create(dto: CreateVoucherDto, pdfBuffer?: Buffer) {
        const issueDate = new Date(dto.issue_date);
        const dueDate = new Date(dto.due_date);
        const validityDate = dto.validity_date ? new Date(dto.validity_date) : null;

        const voucher = await this.prisma.$transaction(async (tx) => {
            // 1. Fetch the fees to be included in the voucher
            const feeRecords = await tx.student_fees.findMany({
                where: {
                    id: { in: dto.orderedFeeIds && dto.orderedFeeIds.length > 0 ? dto.orderedFeeIds : [] },
                    student_id: dto.student_id,
                },
                include: {
                    fee_types: true,
                },
            });

            // Calculate totals
            const totalBeforeDue = feeRecords.reduce((sum, fee) => sum + Number(fee.amount_before_discount), 0);
            const lateFee = dto.late_fee_charge ? (dto.late_fee_amount ?? 1000) : 0;
            const totalAfterDue = totalBeforeDue + lateFee;

            // 2. Create the voucher record
            const newVoucher = await tx.vouchers.create({
                data: {
                    student_id: dto.student_id,
                    campus_id: dto.campus_id,
                    class_id: dto.class_id,
                    section_id: dto.section_id,
                    bank_account_id: dto.bank_account_id,
                    issue_date: issueDate,
                    due_date: dueDate,
                    validity_date: validityDate,
                    late_fee_charge: dto.late_fee_charge,
                    academic_year: dto.academic_year,
                    month: dto.month,
                    total_payable_before_due: totalBeforeDue,
                    total_payable_after_due: totalAfterDue,
                },
                include: VOUCHER_INCLUDE,
            });

            // 3. Create voucher heads (snapshots of fees)
            const voucherHeadsData = feeRecords.map((fee) => ({
                voucher_id: newVoucher.id,
                student_fee_id: fee.id,
                discount_amount: 0, // Placeholder for future use
                net_amount: fee.amount_before_discount ?? 0,
                amount_deposited: 0,
                balance: fee.amount_before_discount ?? 0,
            }));

            await tx.voucher_heads.createMany({
                data: voucherHeadsData,
            });

            // 4. Update student_fees records to mark them as ISSUED and set precedence from fee type
            for (const fee of feeRecords) {
                await tx.student_fees.update({
                    where: { id: fee.id },
                    data: {
                        issue_date: issueDate,
                        due_date: dueDate,
                        validity_date: validityDate,
                        precedence_override: fee.fee_types?.priority_order ?? 0,
                        status: 'ISSUED' as any,
                    },
                });
            }

            // 5. Snapshot each fee line into voucher_heads, capturing the exact price
            //    at the moment of issuance (Snapshot Billing).
            if (dto.fee_lines && dto.fee_lines.length > 0) {
                // Fetch the gross prices stored on student_fees so we don't rely on
                // the caller to re-send data that already exists in the DB.
                const feeIds = dto.fee_lines.map((l) => l.student_fee_id);
                const studentFeeRecords = await tx.student_fees.findMany({
                    where: { id: { in: feeIds } },
                    select: { id: true, amount_before_discount: true },
                });
                const feeAmountMap = new Map(
                    studentFeeRecords.map((sf) => [sf.id, sf.amount_before_discount]),
                );

                let totalBeforeDue = new Prisma.Decimal(0);

                await tx.voucher_heads.createMany({
                    data: dto.fee_lines.map((line) => {
                        const gross = feeAmountMap.get(line.student_fee_id) ?? new Prisma.Decimal(0);
                        const discount = new Prisma.Decimal(line.discount_amount ?? 0);
                        const netAmount = new Prisma.Decimal(gross).sub(discount);
                        totalBeforeDue = totalBeforeDue.add(netAmount);
                        return {
                            voucher_id: newVoucher.id, // Use newVoucher.id from step 2
                            student_fee_id: line.student_fee_id,
                            discount_amount: discount,
                            net_amount: netAmount,
                            amount_deposited: new Prisma.Decimal(0),
                            balance: netAmount,
                        };
                    }),
                    skipDuplicates: true,
                });

                // Update voucher with final totals derived from heads
                const lateFee = dto.late_fee_charge ? (dto.late_fee_amount ?? 1000) : 0;
                const totalAfterDue = totalBeforeDue.add(lateFee);

                await tx.vouchers.update({
                    where: { id: newVoucher.id },
                    data: {
                        total_payable_before_due: totalBeforeDue,
                        total_payable_after_due: totalAfterDue,
                    },
                });
            }

            return newVoucher;
        });

        // 6. Upload PDF if provided (Outside transaction to avoid timeout)
        if (pdfBuffer) {
            try {
                const key = `vouchers/${dto.student_id}/voucher-${voucher.id}-${Date.now()}.pdf`;
                const pdfUrl = await this.storage.upload(key, pdfBuffer);

                const updatedVoucher = await this.prisma.vouchers.update({
                    where: { id: voucher.id },
                    data: { pdf_url: pdfUrl },
                    include: VOUCHER_INCLUDE,
                });

                return updatedVoucher;
            } catch (error) {
                this.logger.error(`Failed to upload PDF for voucher ${voucher.id}: ${error.message}`);
                // Return the voucher anyway as the DB records are already committed
                return voucher;
            }
        }

        return voucher;
    }

    async findAll(
        studentId?: number,
        campusId?: number,
        status?: string,
        classId?: number,
        sectionId?: number,
        cc?: number,
        gr?: string,
    ) {
        try {
            return await this.prisma.vouchers.findMany({
                where: {
                    // student_id or cc both resolve to student_id (cc is the student PK)
                    ...(cc ? { student_id: cc } : studentId ? { student_id: studentId } : {}),
                    ...(campusId ? { campus_id: campusId } : {}),
                    ...(classId ? { class_id: classId } : {}),
                    ...(sectionId ? { section_id: sectionId } : {}),
                    ...(status ? { status } : {}),
                    ...(gr
                        ? {
                              students: {
                                  gr_number: { contains: gr, mode: 'insensitive' },
                              },
                          }
                        : {}),
                },
                include: VOUCHER_INCLUDE,
                orderBy: { issue_date: 'desc' },
            });
        } catch (err: any) {
            this.logger.error('findAll failed', err?.message, err?.stack);
            throw new InternalServerErrorException(
                `Voucher query failed: ${err?.message ?? 'Unknown error'}`,
            );
        }
    }

    async findOne(id: number) {
        const voucher = await this.prisma.vouchers.findUnique({
            where: { id },
            include: VOUCHER_INCLUDE,
        });

        if (!voucher) {
            throw new NotFoundException(`Voucher with ID ${id} not found`);
        }

        return voucher;
    }

    async update(id: number, dto: UpdateVoucherDto) {
        await this.findOne(id); // ensure it exists

        return this.prisma.vouchers.update({
            where: { id },
            data: {
                ...(dto.issue_date ? { issue_date: new Date(dto.issue_date) } : {}),
                ...(dto.due_date ? { due_date: new Date(dto.due_date) } : {}),
                ...(dto.validity_date !== undefined ? { validity_date: dto.validity_date ? new Date(dto.validity_date) : null } : {}),
                ...(dto.status !== undefined ? { status: dto.status } : {}),
                ...(dto.late_fee_charge !== undefined ? { late_fee_charge: dto.late_fee_charge } : {}),
                ...(dto.bank_account_id ? { bank_account_id: dto.bank_account_id } : {}),
                ...(dto.section_id !== undefined ? { section_id: dto.section_id } : {}),
            },
            include: VOUCHER_INCLUDE,
        });
    }
}
