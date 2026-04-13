import {
    BadRequestException,
    Injectable,
    InternalServerErrorException,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateVoucherDto } from './dto/create-voucher.dto';
import { CreateBulkVouchersDto } from './dto/create-bulk-vouchers.dto';
import { PreviewBulkVouchersDto } from './dto/preview-bulk-vouchers.dto';
import { UpdateVoucherDto } from './dto/update-voucher.dto';
import { RecordVoucherDepositDto } from './dto/record-voucher-deposit.dto';
import { SplitPartiallyPaidDto } from './dto/split-partially-paid.dto';
import { StorageService } from '../../common/storage/storage.service';
import { VoucherPdfService } from '../voucher-pdf/voucher-pdf.service';

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
    voucher_heads: {
        include: {
            student_fees: {
                include: {
                    fee_types: true,
                    student_fee_bundles: true
                }
            }
        }
    }
};

@Injectable()
export class VouchersService {
    private readonly logger = new Logger(VouchersService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly storage: StorageService,
        private readonly pdfService: VoucherPdfService,
    ) {}

    async create(dto: CreateVoucherDto, pdfBuffer?: Buffer) {
        // --- Temporary Debug Check for orderedFeeIds ---
        if (!dto.orderedFeeIds || dto.orderedFeeIds.length === 0) {
            throw new BadRequestException({
                message: "orderedFeeIds is missing or contains only invalid integers.",
                debug: {
                    receivedDto: { ...dto, pdf: undefined },
                }
            });
        }

        const issueDate = new Date(dto.issue_date);
        const dueDate = new Date(dto.due_date);
        const validityDate = dto.validity_date ? new Date(dto.validity_date) : null;
        const feeDate = dto.fee_date ? new Date(dto.fee_date) : null;

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

            // 2. Create the voucher record (initial creation with placeholder totals)
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
                    month: dto.month ?? null,
                    fee_date: feeDate,
                    total_payable_before_due: 0,
                    total_payable_after_due: 0,
                },
                include: VOUCHER_INCLUDE,
            });

            // 3. Create voucher heads (snapshots of fees with current prices and discounts)
            const feeLineMap = new Map(
                (dto.fee_lines || []).map(l => [l.student_fee_id, l])
            );

            let totalBeforeDueDecimal = new Prisma.Decimal(0);

            const voucherHeadsData = feeRecords.map((fee) => {
                const discountInfo = feeLineMap.get(fee.id);
                // Fall back to amount when amount_before_discount is null (no discount record)
                const gross = fee.amount_before_discount ?? fee.amount ?? new Prisma.Decimal(0);
                const discount = new Prisma.Decimal(discountInfo?.discount_amount ?? 0);
                const netAmount = new Prisma.Decimal(gross).sub(discount);
                
                totalBeforeDueDecimal = totalBeforeDueDecimal.add(netAmount);

                return {
                    voucher_id: newVoucher.id,
                    student_fee_id: fee.id,
                    discount_amount: discount,
                    discount_label: discountInfo?.discount_label ?? null,
                    net_amount: netAmount,
                    amount_deposited: 0,
                    balance: netAmount,
                };
            });

            await tx.voucher_heads.createMany({
                data: voucherHeadsData,
            });

            // 4. Update student_fees records to mark them as ISSUED
            await Promise.all(
                feeRecords.map((fee) =>
                    tx.student_fees.update({
                        where: { id: fee.id },
                        data: {
                            issue_date: issueDate,
                            due_date: dueDate,
                            validity_date: validityDate,
                            precedence_override: fee.fee_types?.priority_order ?? 0,
                            status: 'ISSUED' as any,
                        },
                    }),
                ),
            );

            // 5. Update voucher with final totals derived from heads
            const lateFeeVal = dto.late_fee_charge ? (dto.late_fee_amount ?? 1000) : 0;
            const totalAfterDueDecimal = totalBeforeDueDecimal.add(lateFeeVal);

            await tx.vouchers.update({
                where: { id: newVoucher.id },
                data: {
                    total_payable_before_due: totalBeforeDueDecimal,
                    total_payable_after_due: totalAfterDueDecimal,
                },
            });

            // 6. Void any superseded vouchers — older vouchers for the same student
            //    that share one or more of the fee IDs now absorbed by this new voucher.
            //    This prevents double-payment of arrear heads that have been rolled in.
            const feeIdsInNewVoucher = dto.orderedFeeIds ?? [];
            if (feeIdsInNewVoucher.length > 0) {
                // Find heads from OTHER vouchers that reference the same student_fee rows
                const supersededHeads = await tx.voucher_heads.findMany({
                    where: {
                        student_fee_id: { in: feeIdsInNewVoucher },
                        voucher_id: { not: newVoucher.id },
                    },
                    select: { voucher_id: true },
                });

                const supersededVoucherIds = [
                    ...new Set(supersededHeads.map((h) => h.voucher_id)),
                ];

                if (supersededVoucherIds.length > 0) {
                    await tx.vouchers.updateMany({
                        where: {
                            id: { in: supersededVoucherIds },
                            student_id: dto.student_id,
                            status: { notIn: ['PAID', 'VOID'] },
                        },
                        data: { status: 'VOID' },
                    });
                    this.logger.log(
                        `[Voucher ${newVoucher.id}] Voided ${supersededVoucherIds.length} superseded voucher(s): [${supersededVoucherIds.join(', ')}]`,
                    );
                }
            }

            return newVoucher;
        }, { timeout: 15000 });

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
                this.logger.error(`Failed to upload PDF for voucher ${voucher.id}: ${(error as Error).message}`);
                // Return the voucher anyway as the DB records are already committed
                return voucher;
            }
        }

        return voucher;
    }

    async previewBulk(dto: PreviewBulkVouchersDto) {
        const selection = await this.getBulkVoucherSelection({
            campus_id: dto.campus_id,
            class_id: dto.class_id,
            section_id: dto.section_id,
            academic_year: dto.academic_year,
            month: dto.month,
            fee_date: dto.fee_date,
            issue_date: dto.issue_date,
        });

        return {
            filters: {
                campus_id: dto.campus_id,
                class_id: dto.class_id ?? null,
                section_id: dto.section_id ?? null,
                academic_year: dto.academic_year,
                month: dto.month ?? null,
                fee_date: dto.fee_date ?? null,
            },
            total_matched_students: selection.totalMatchedStudents,
            eligible_students: selection.eligibleStudents.length,
            skipped_no_fee_schedule: selection.skippedNoFeeSchedule.length,
            skipped_already_issued: selection.skippedAlreadyIssued.length,
            skipped_missing_assignment: selection.skippedMissingAssignment.length,
            eligible_student_ids: selection.eligibleStudents.map((s) => s.student_id),
        };
    }

    async createBulk(dto: CreateBulkVouchersDto) {
        const selection = await this.getBulkVoucherSelection({
            campus_id: dto.campus_id,
            class_id: dto.class_id,
            section_id: dto.section_id,
            academic_year: dto.academic_year,
            month: dto.month,
            fee_date: dto.fee_date,
            issue_date: dto.issue_date,
        });

        const generated: number[] = [];
        const generatedVoucherIds: number[] = [];
        const failed: { student_id: number; reason: string }[] = [];

        for (const item of selection.eligibleStudents) {
            try {
                const voucherDto: CreateVoucherDto = {
                    student_id: item.student_id,
                    campus_id: item.campus_id,
                    class_id: item.class_id,
                    section_id: item.section_id ?? undefined,
                    bank_account_id: dto.bank_account_id,
                    issue_date: dto.issue_date,
                    due_date: dto.due_date,
                    validity_date: dto.validity_date,
                    late_fee_charge: dto.late_fee_charge ?? true,
                    late_fee_amount: dto.late_fee_amount,
                    academic_year: dto.academic_year,
                    month: dto.month ?? undefined,
                    fee_date: dto.fee_date,
                    precedence: 1,
                    orderedFeeIds: item.fee_ids,
                    fee_lines: item.fee_lines,
                };

                const created = await this.create(voucherDto);
                generated.push(item.student_id);
                if (created?.id) {
                    generatedVoucherIds.push(created.id);
                }
            } catch (error: any) {
                this.logger.error(
                    `Bulk voucher creation failed for student ${item.student_id}: ${error?.message ?? 'Unknown error'}`,
                );
                failed.push({
                    student_id: item.student_id,
                    reason: error?.message ?? 'Failed to create voucher',
                });
            }
        }

        return {
            filters: {
                campus_id: dto.campus_id,
                class_id: dto.class_id ?? null,
                section_id: dto.section_id ?? null,
                academic_year: dto.academic_year,
                month: dto.month ?? null,
                fee_date: dto.fee_date ?? null,
            },
            total_matched_students: selection.totalMatchedStudents,
            generated_count: generated.length,
            skipped_no_fee_schedule: selection.skippedNoFeeSchedule.length,
            skipped_already_issued: selection.skippedAlreadyIssued.length,
            skipped_missing_assignment: selection.skippedMissingAssignment.length,
            failed_count: failed.length,
            generated_student_ids: generated,
            generated_voucher_ids: generatedVoucherIds,
            failed_students: failed,
        };
    }

    async findAll(
        studentId?: number,
        campusId?: number,
        status?: string,
        classId?: number,
        sectionId?: number,
        cc?: number,
        gr?: string,
        id?: number,
        dateFrom?: string,
        dateTo?: string,
    ) {
        try {
            const vouchers = await this.prisma.vouchers.findMany({
                where: {
                    // student_id or cc both resolve to student_id (cc is the student PK)
                    ...(cc ? { student_id: cc } : studentId ? { student_id: studentId } : {}),
                    ...(id ? { id } : {}),
                    ...(campusId ? { campus_id: campusId } : {}),
                    ...(classId ? { class_id: classId } : {}),
                    ...(sectionId ? { section_id: sectionId } : {}),
                    ...(status ? { status } : {}),
                    ...(dateFrom || dateTo
                        ? {
                              fee_date: {
                                  ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
                                  ...(dateTo ? { lte: new Date(dateTo) } : {}),
                              },
                          }
                        : {}),
                    ...(gr
                        ? {
                              students: {
                                  gr_number: { contains: gr, mode: 'insensitive' },
                              },
                          }
                        : {}),
                },
                include: VOUCHER_INCLUDE,
                orderBy: [{ issue_date: 'desc' }, { id: 'desc' }],
            });
            return vouchers.map((v) => this.normalizeVoucher(v));
        } catch (err: any) {
            this.logger.error('findAll failed', err?.message, err?.stack);
            throw new InternalServerErrorException(
                `Voucher query failed: ${err?.message ?? 'Unknown error'}`,
            );
        }
    }

    /** Helper to prepare data for VoucherPdfService */
    private async prepareVoucherPdfData(voucher: any, paidStamp?: boolean, descriptionPrefix?: string) {
        // 1. Fetch siblings if family_id exists
        let siblings: any[] = [];
        if (voucher.students?.family_id) {
            siblings = await this.prisma.students.findMany({
                where: { family_id: voucher.students.family_id, deleted_at: null, status: 'ENROLLED' },
                include: { classes: true, sections: true }
            });
        }

        // 2. Map heads correctly
        const feeHeads = voucher.voucher_heads.map((h: any) => ({
            description: `${descriptionPrefix || ''}${h.student_fees?.fee_types?.description || 'Fee'}`,
            amount: Number(h.student_fees?.amount_before_discount || h.net_amount || 0),
            discount: Number(h.discount_amount || 0),
            netAmount: Number(h.net_amount),
            discountLabel: h.discount_label || '',
        }));

        const totalAmount = Number(voucher.total_payable_before_due || 0);
        const lateFeeAmount = voucher.late_fee_charge ? 1000 : 0;

        // Resolve Month Label
        const monthNames = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
        const monthLabel = voucher.month ? monthNames[voucher.month] : (voucher.fee_date ? new Date(voucher.fee_date).toLocaleString('default', { month: 'long' }) : 'N/A');

        // Prepare Key & QR URL
        const ts = Date.now();
        const key = `vouchers/${voucher.student_id}/voucher-${voucher.id}-${ts}.pdf`;
        const qrUrl = this.storage.getPublicUrl(key);

        return {
            voucherData: {
                voucherNumber: voucher.id.toString(),
                student: {
                    cc: voucher.students.cc,
                    classId: voucher.class_id,
                    fullName: voucher.students.full_name,
                    fatherName: (voucher.students as any).father_name || 'N/A',
                    gender: (voucher.students as any).gender || 'N/A',
                    grNumber: voucher.students.gr_number || 'N/A',
                    className: voucher.classes?.description || 'N/A',
                    sectionName: voucher.sections?.description || 'N/A',
                },
                siblings: siblings.filter(s => s.cc !== voucher.student_id).map(s => ({
                    cc: s.cc,
                    fullName: s.full_name,
                    grNumber: s.gr_number || 'N/A',
                    className: s.classes?.description || 'N/A',
                    sectionName: s.sections?.description || 'N/A',
                })),
                campusName: voucher.campuses?.campus_name || 'Main Campus',
                academicYear: voucher.academic_year || 'N/A',
                month: monthLabel,
                issueDate: voucher.issue_date.toISOString().split('T')[0],
                dueDate: voucher.due_date.toISOString().split('T')[0],
                validityDate: voucher.validity_date ? voucher.validity_date.toISOString().split('T')[0] : 'N/A',
                bank: {
                    name: voucher.bank_accounts?.bank_name || 'N/A',
                    title: voucher.bank_accounts?.account_title || 'N/A',
                    account: voucher.bank_accounts?.account_number || 'N/A',
                    iban: voucher.bank_accounts?.iban || 'N/A',
                    address: voucher.bank_accounts?.bank_address || 'N/A',
                },
                feeHeads,
                totalAmount,
                lateFeeAmount,
                qrUrl,
                paidStamp,
                showDiscount: true,
            },
            key
        };
    }

    async findOne(id: number) {
        const voucher = await this.prisma.vouchers.findUnique({
            where: { id },
            include: VOUCHER_INCLUDE,
        });

        if (!voucher) {
            throw new NotFoundException(`Voucher with ID ${id} not found`);
        }

        return this.normalizeVoucher(voucher);
    }

    async findByStudentCC(cc: number, familyId?: number) {
        const vouchers = await this.prisma.vouchers.findMany({
            where: { 
                student_id: cc,
                ...(familyId ? { students: { family_id: familyId } } : {})
            },
            include: VOUCHER_INCLUDE,
            orderBy: { issue_date: 'asc' },
        });
        return vouchers.map((v) => this.normalizeVoucher(v));
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

    async recordDeposit(voucherId: number, dto: RecordVoucherDepositDto) {
        const depositAmount = new Prisma.Decimal(dto.amount);
        const lateFeeAmount = new Prisma.Decimal(dto.late_fee ?? 0);
        const distributionEntries = Object.entries(dto.distributions ?? {});

        if (distributionEntries.length === 0 && lateFeeAmount.eq(0)) {
            throw new BadRequestException(
                'Provide at least one voucher head distribution or late fee amount.',
            );
        }

        const parsedDistributions = distributionEntries.map(([rawHeadId, rawAmount]) => {
            const headId = Number(rawHeadId);
            if (!Number.isInteger(headId) || headId <= 0) {
                throw new BadRequestException(
                    `Invalid voucher head id '${rawHeadId}' in distributions.`,
                );
            }

            const amount = new Prisma.Decimal(rawAmount ?? 0);
            if (amount.lt(0)) {
                throw new BadRequestException(
                    `Distribution amount cannot be negative for head #${headId}.`,
                );
            }

            return { headId, amount };
        });

        const headsTotal = parsedDistributions.reduce(
            (sum, item) => sum.add(item.amount),
            new Prisma.Decimal(0),
        );
        const distributedTotal = headsTotal.add(lateFeeAmount);

        if (!distributedTotal.eq(depositAmount)) {
            throw new BadRequestException(
                'Deposit amount must equal the sum of distributions and late fee.',
            );
        }

        // 1. PRE-TRANSACTION VALIDATION
        const voucher = await this.prisma.vouchers.findUnique({
            where: { id: voucherId },
            include: { voucher_heads: true },
        });

        if (!voucher) {
            throw new NotFoundException(`Voucher with ID ${voucherId} not found`);
        }

        if (voucher.status === 'VOID') {
            throw new BadRequestException(
                `Voucher #${voucherId} has been voided and superseded by a newer voucher. Record the deposit against the newer voucher instead.`,
            );
        }

        const voucherHeadMap = new Map(
            voucher.voucher_heads.map((h) => [h.id, h]),
        );

        for (const { headId, amount } of parsedDistributions) {
            const head = voucherHeadMap.get(headId);
            if (!head) {
                throw new BadRequestException(
                    `Voucher head #${headId} does not belong to voucher #${voucherId}.`,
                );
            }

            const currentBalance = new Prisma.Decimal(head.balance ?? 0);
            if (amount.gt(currentBalance)) {
                throw new BadRequestException(
                    `Distribution for head #${headId} exceeds its balance.`,
                );
            }
        }

        const currentBeforeDue = new Prisma.Decimal(
            voucher.total_payable_before_due ?? 0,
        );
        const currentAfterDue = new Prisma.Decimal(
            voucher.total_payable_after_due ?? 0,
        );
        const remainingLateFee = voucher.late_fee_charge
            ? Prisma.Decimal.max(
                  currentAfterDue.sub(currentBeforeDue),
                  new Prisma.Decimal(0),
              )
            : new Prisma.Decimal(0);

        if (lateFeeAmount.gt(remainingLateFee)) {
            throw new BadRequestException(
                'Late fee allocation exceeds the remaining late surcharge.',
            );
        }

        const affectedStudentFeeIds: number[] = [
            ...new Set(
                parsedDistributions
                    .map((d) => voucherHeadMap.get(d.headId)?.student_fee_id)
                    .filter(Boolean) as number[],
            ),
        ];

        // 2. LEAN TRANSACTION
        await this.prisma.$transaction(
            async (tx) => {

            // ── Step A: Update voucher_heads balances ──────────────────────
            await Promise.all(
                parsedDistributions.map(({ headId, amount }) => {
                    if (amount.eq(0)) return Promise.resolve();
                    return tx.voucher_heads.update({
                        where: { id: headId },
                        data: {
                            amount_deposited: { increment: amount },
                            balance: { decrement: amount },
                        },
                    });
                }),
            );

            // ── Step B: Write to deposits + deposit_allocations ───────────
            const depositRecord = await tx.deposits.create({
                data: {
                    student_id: voucher.student_id,
                    total_amount: depositAmount,
                    payment_method: dto.payment_method ?? null,
                    reference_number: dto.reference_number ?? null,
                },
            });

            // One allocation per non-zero head distribution
            const allocationData: {
                deposit_id: number;
                student_fee_id: number | null;
                voucher_id: number;
                amount: Prisma.Decimal;
                type: string;
            }[] = parsedDistributions
                .filter(({ amount }) => amount.gt(0))
                .map(({ headId, amount }) => {
                    const head = voucherHeadMap.get(headId)!;
                    return {
                        deposit_id: depositRecord.id,
                        student_fee_id: head.student_fee_id ?? null,
                        voucher_id: voucherId,
                        amount,
                        type: 'FEE_HEAD',
                    };
                });

            // One allocation for late fee if applicable
            if (lateFeeAmount.gt(0)) {
                allocationData.push({
                    deposit_id: depositRecord.id,
                    student_fee_id: null,
                    voucher_id: voucherId,
                    amount: lateFeeAmount,
                    type: 'LATE_FEE',
                });
            }

            if (allocationData.length > 0) {
                await tx.deposit_allocations.createMany({ data: allocationData });
            }

            // ── Step C: Update student_fees (amount_paid + status) ─────────
            if (affectedStudentFeeIds.length > 0) {
                const totalDeposits = await tx.voucher_heads.groupBy({
                    by: ['student_fee_id'],
                    where: { student_fee_id: { in: affectedStudentFeeIds } },
                    _sum: { amount_deposited: true },
                });

                const studentFees = await tx.student_fees.findMany({
                    where: { id: { in: affectedStudentFeeIds } },
                });

                await Promise.all(
                    studentFees.map((fee) => {
                        const deposit = totalDeposits.find(
                            (d) => d.student_fee_id === fee.id,
                        );
                        const totalDeposited = new Prisma.Decimal(
                            deposit?._sum.amount_deposited ?? 0,
                        );
                        // student_fees.amount is the canonical net amount (source of truth)
                        const canonicalAmount = new Prisma.Decimal(
                            fee.amount ?? fee.amount_before_discount ?? 0,
                        );
                        const nextFeeBalance = Prisma.Decimal.max(
                            canonicalAmount.sub(totalDeposited),
                            new Prisma.Decimal(0),
                        );

                        let nextFeeStatus: 'ISSUED' | 'PARTIALLY_PAID' | 'PAID' = 'ISSUED';
                        if (nextFeeBalance.eq(0)) {
                            nextFeeStatus = 'PAID';
                        } else if (totalDeposited.gt(0)) {
                            nextFeeStatus = 'PARTIALLY_PAID';
                        }

                        return tx.student_fees.update({
                            where: { id: fee.id },
                            data: {
                                status: nextFeeStatus as any,
                                amount_paid: totalDeposited,
                            },
                        });
                    }),
                );
            }

            // ── Step D: Update late_fee_deposited on voucher ───────────────
            if (lateFeeAmount.gt(0)) {
                await tx.vouchers.update({
                    where: { id: voucherId },
                    data: {
                        late_fee_deposited: { increment: lateFeeAmount },
                    } as any,
                });
            }

            // ── Step E: Recalculate voucher status ─────────────────────────
                // Minimal refresh for calculation - much faster than full VOUCHER_INCLUDE
                const refreshed = await tx.vouchers.findUnique({
                    where: { id: voucherId },
                    include: {
                        voucher_heads: true,
                    },
                });

                if (!refreshed) {
                    throw new NotFoundException(`Voucher with ID ${voucherId} not found`);
                }

                const remainingHeads = refreshed.voucher_heads.reduce(
                    (sum, head) => sum.add(new Prisma.Decimal(head.balance as any ?? 0)),
                    new Prisma.Decimal(0),
                );

                const tAfter = new Prisma.Decimal((refreshed as any).total_payable_after_due ?? 0);
                const tBefore = new Prisma.Decimal((refreshed as any).total_payable_before_due ?? 0);
                const totalLateSurcharge = Prisma.Decimal.max(tAfter.sub(tBefore), 0);
                const depositedLS = new Prisma.Decimal((refreshed as any).late_fee_deposited ?? 0);
                const remainingLS = Prisma.Decimal.max(totalLateSurcharge.sub(depositedLS), 0);

                const isOverdue = new Date() > new Date(refreshed.due_date);
                const remainingOverall = isOverdue ? remainingHeads.add(remainingLS) : remainingHeads;

                let nextVoucherStatus = refreshed.status ?? 'UNPAID';
                if (remainingOverall.eq(0)) {
                    nextVoucherStatus = 'PAID';
                } else if (isOverdue) {
                    nextVoucherStatus = 'OVERDUE';
                } else {
                    const anyHeadDeposited = refreshed.voucher_heads.some((h) =>
                        new Prisma.Decimal(h.amount_deposited as any ?? 0).gt(0),
                    );
                    if (anyHeadDeposited || depositedLS.gt(0)) {
                        nextVoucherStatus = 'PARTIALLY_PAID';
                    } else {
                        nextVoucherStatus = 'UNPAID';
                    }
                }

                if (nextVoucherStatus !== refreshed.status) {
                    await tx.vouchers.update({
                        where: { id: voucherId },
                        data: { status: nextVoucherStatus },
                    });
                }
            },
            { timeout: 30000 },
        );

        // 3. FINAL FULL FETCH
        return this.findOne(voucherId);
    }

    async savePaidPdf(voucherId: number, pdfBuffer: Buffer) {
        const voucher = await this.prisma.vouchers.findUnique({ where: { id: voucherId } });
        if (!voucher) throw new NotFoundException(`Voucher ${voucherId} not found`);

        const key = `vouchers/${voucher.student_id}/paid-voucher-${voucherId}-${Date.now()}.pdf`;
        const pdfUrl = await this.storage.upload(key, pdfBuffer);
        await this.prisma.vouchers.update({ where: { id: voucherId }, data: { pdf_url: pdfUrl } });
        return { pdf_url: pdfUrl };
    }

    /**
     * Split a PARTIALLY_PAID voucher:
     *  1. Create a new PAID voucher   (heads = amount_deposited, prefix "Partial Payment of —")
     *  2. Create a new UNPAID voucher (heads = balance,          prefix "Balance Payment of —")
     *  3. Delete the original voucher (voucher_heads cascade, deposit_allocations reassigned)
     */
    async splitPartiallyPaid(
        voucherId: number,
        dto: SplitPartiallyPaidDto,
    ) {
        const original = await this.prisma.vouchers.findUnique({
            where: { id: voucherId },
            include: VOUCHER_INCLUDE,
        });

        if (!original) throw new NotFoundException(`Voucher ${voucherId} not found`);
        if (original.status !== 'PARTIALLY_PAID') {
            throw new BadRequestException(
                `Voucher ${voucherId} is not PARTIALLY_PAID (current status: ${original.status}).`,
            );
        }

        // Fetch heads with full student_fees data for descriptions
        const allHeads = await this.prisma.voucher_heads.findMany({
            where: { voucher_id: voucherId },
            include: { student_fees: { include: { fee_types: true } } },
        });

        const paidHeads = allHeads.filter(h => new Prisma.Decimal(h.amount_deposited as any ?? 0).gt(0));
        const unpaidHeads = allHeads.filter(h => new Prisma.Decimal(h.balance as any ?? 0).gt(0));

        if (paidHeads.length === 0) throw new BadRequestException('No deposited amounts found on this voucher.');
        if (unpaidHeads.length === 0) throw new BadRequestException('No outstanding balance found on this voucher.');

        const issueDate = new Date(dto.issue_date);
        const dueDate = new Date(dto.due_date);
        const validityDate = dto.validity_date ? new Date(dto.validity_date) : null;

        const lateFeeVal = original.late_fee_charge ? new Prisma.Decimal(1000) : new Prisma.Decimal(0);

        const paidTotal = paidHeads.reduce(
            (s, h) => s.add(new Prisma.Decimal(h.amount_deposited as any ?? 0)),
            new Prisma.Decimal(0),
        );
        const unpaidTotal = unpaidHeads.reduce(
            (s, h) => s.add(new Prisma.Decimal(h.balance as any ?? 0)),
            new Prisma.Decimal(0),
        );

        // --- Execute Split Transaction ---
        const { paidVoucher, unpaidVoucher } = await this.prisma.$transaction(async (tx) => {
            const commonFields = {
                student_id: original.student_id,
                campus_id: original.campus_id,
                class_id: original.class_id,
                section_id: original.section_id,
                bank_account_id: original.bank_account_id,
                academic_year: original.academic_year,
                month: original.month,
                fee_date: original.fee_date,
                late_fee_charge: original.late_fee_charge,
            };

            // --- 1. Create the PAID portion voucher ---
            const paid = await tx.vouchers.create({
                data: {
                    ...commonFields,
                    issue_date: original.issue_date,
                    due_date: original.due_date,
                    validity_date: original.validity_date,
                    status: 'PAID',
                    total_payable_before_due: paidTotal,
                    total_payable_after_due: paidTotal,
                },
            });

            await tx.voucher_heads.createMany({
                data: paidHeads.map(h => ({
                    voucher_id: paid.id,
                    student_fee_id: h.student_fee_id,
                    discount_amount: new Prisma.Decimal(0),
                    discount_label: h.discount_label,
                    net_amount: new Prisma.Decimal(h.amount_deposited as any ?? 0),
                    amount_deposited: new Prisma.Decimal(h.amount_deposited as any ?? 0),
                    balance: new Prisma.Decimal(0),
                })),
            });

            // --- 2. Create the UNPAID balance voucher ---
            const unpaid = await tx.vouchers.create({
                data: {
                    ...commonFields,
                    issue_date: issueDate,
                    due_date: dueDate,
                    validity_date: validityDate,
                    status: 'UNPAID',
                    total_payable_before_due: unpaidTotal,
                    total_payable_after_due: unpaidTotal.add(lateFeeVal),
                },
            });

            await tx.voucher_heads.createMany({
                data: unpaidHeads.map(h => ({
                    voucher_id: unpaid.id,
                    student_fee_id: h.student_fee_id,
                    discount_amount: new Prisma.Decimal(0),
                    discount_label: h.discount_label,
                    net_amount: new Prisma.Decimal(h.balance as any ?? 0),
                    amount_deposited: new Prisma.Decimal(0),
                    balance: new Prisma.Decimal(h.balance as any ?? 0),
                })),
            });

            // --- 3. Reassign deposit_allocations to new paid voucher, then delete the original ---
            await tx.deposit_allocations.updateMany({
                where: { voucher_id: voucherId },
                data: { voucher_id: paid.id },
            });

            await tx.vouchers.delete({ where: { id: voucherId } });

            return { paidVoucher: paid, unpaidVoucher: unpaid };
        }, { timeout: 30000 });

        // --- Generate and Upload PDFs on Backend ---
        // Fetch full models for prepareVoucherPdfData
        const paidFull = await this.prisma.vouchers.findUnique({ where: { id: paidVoucher.id }, include: VOUCHER_INCLUDE });
        const unpaidFull = await this.prisma.vouchers.findUnique({ where: { id: unpaidVoucher.id }, include: VOUCHER_INCLUDE });

        const [pData, uData] = await Promise.all([
            this.prepareVoucherPdfData(paidFull, true, 'Partial Payment of — '),
            this.prepareVoucherPdfData(unpaidFull, false, 'Balance Payment of — '),
        ]);

        const [pBuf, uBuf] = await Promise.all([
            this.pdfService.generateVoucherPdf(pData.voucherData),
            this.pdfService.generateVoucherPdf(uData.voucherData),
        ]);

        const [pUrl, uUrl] = await Promise.all([
            this.storage.upload(pData.key, pBuf),
            this.storage.upload(uData.key, uBuf),
        ]);

        await Promise.all([
            this.prisma.vouchers.update({ where: { id: paidVoucher.id }, data: { pdf_url: pUrl } }),
            this.prisma.vouchers.update({ where: { id: unpaidVoucher.id }, data: { pdf_url: uUrl } }),
        ]);

        return {
            paid_voucher_id: paidVoucher.id,
            unpaid_voucher_id: unpaidVoucher.id,
            paid_pdf_url: pUrl,
            unpaid_pdf_url: uUrl,
        };
    }

    private normalizeVoucher(voucher: any) {
        if (!voucher) return null;

        // VOID is a manual override (superseded voucher) — never recalculate it.
        if (voucher.status === 'VOID') return voucher;

        const originalHeads: any[] = voucher.voucher_heads || [];
        const updatedHeads: any[] = [];
        let totalRemHeads = new Prisma.Decimal(0);
        let anyHeadPaidSomewhere = false;

        this.logger.debug(`Normalizing Voucher #${voucher.id} (DB Status: ${voucher.status})`);

        for (const h of originalHeads) {
            const fee = h.student_fees;
            if (!fee) {
                const bal = new Prisma.Decimal(h.balance ?? 0);
                totalRemHeads = totalRemHeads.add(bal);
                updatedHeads.push(h);
                continue;
            }

            // student_fees is the SINGLE SOURCE OF TRUTH for amounts and paid state.
            const canonicalAmount = new Prisma.Decimal(fee.amount ?? fee.amount_before_discount ?? 0);
            const totalPaidOnFee = new Prisma.Decimal(fee.amount_paid ?? 0);
            const headRem = Prisma.Decimal.max(canonicalAmount.sub(totalPaidOnFee), new Prisma.Decimal(0));

            this.logger.debug(`  Head #${h.id}: SF Amount=${canonicalAmount}, SF Paid=${totalPaidOnFee} => Derived Balance=${headRem}`);

            if (totalPaidOnFee.gt(0)) anyHeadPaidSomewhere = true;
            totalRemHeads = totalRemHeads.add(headRem);

            // Overwrite stored balance with the canonical derived value
            updatedHeads.push({ 
                ...h, 
                balance: headRem.toString() // Stringify for reliable JSON serialization
            });
        }

        // ── sf totals (for frontend display) ────────────────────────────────────
        const sfNetTotal = originalHeads.reduce(
            (sum, head) => sum.add(new Prisma.Decimal(head.student_fees?.amount ?? head.net_amount ?? 0)),
            new Prisma.Decimal(0),
        );
        const sfGrossTotal = originalHeads.reduce(
            (sum, head) => sum.add(new Prisma.Decimal(head.student_fees?.amount_before_discount ?? head.student_fees?.amount ?? head.net_amount ?? 0)),
            new Prisma.Decimal(0),
        );
        const sfDiscountTotal = sfGrossTotal.sub(sfNetTotal);

        // ── Late-fee surcharge ────────────────────────────────────────────────────
        const tAfter = new Prisma.Decimal((voucher as any).total_payable_after_due ?? 0);
        const tBefore = new Prisma.Decimal((voucher as any).total_payable_before_due ?? 0);
        const depLS = new Prisma.Decimal((voucher as any).late_fee_deposited ?? 0);
        const totalLS = Prisma.Decimal.max(tAfter.sub(tBefore), new Prisma.Decimal(0));
        const remLS = Prisma.Decimal.max(totalLS.sub(depLS), new Prisma.Decimal(0));

        const isOverdue = new Date() > new Date(voucher.due_date);
        const remOverall = isOverdue ? totalRemHeads.add(remLS) : totalRemHeads;

        this.logger.debug(`  Voucher #${voucher.id} Final Calculation: headRemTotal=${totalRemHeads}, remLS=${remLS}, isOverdue=${isOverdue} => remOverall=${remOverall}`);

        // ── Compute status entirely from derived state ──────────────────────────
        let computedStatus: string;
        if (remOverall.lte(0)) {
            computedStatus = 'PAID';
        } else if (isOverdue) {
            computedStatus = 'OVERDUE';
        } else {
            const anyDep = anyHeadPaidSomewhere || depLS.gt(0);
            computedStatus = anyDep ? 'PARTIALLY_PAID' : 'UNPAID';
        }

        this.logger.debug(`  Voucher #${voucher.id} Result: Computed Status=${computedStatus}`);

        return {
            ...voucher,
            voucher_heads: updatedHeads,
            sf_net_total: sfNetTotal.toFixed(2),
            sf_gross_total: sfGrossTotal.toFixed(2),
            sf_discount_total: sfDiscountTotal.toFixed(2),
            status: computedStatus,
        };
    }

    private async getBulkVoucherSelection(filters: {
        campus_id: number;
        class_id?: number;
        section_id?: number;
        academic_year: string;
        month?: number;
        fee_date?: string;
        issue_date?: string;
    }) {
        const students = await this.prisma.students.findMany({
            where: {
                deleted_at: null,
                campus_id: filters.campus_id,
                ...(filters.class_id ? { class_id: filters.class_id } : {}),
                ...(filters.section_id ? { section_id: filters.section_id } : {}),
            },
            select: {
                cc: true,
                campus_id: true,
                class_id: true,
                section_id: true,
            },
        });

        const totalMatchedStudents = students.length;
        if (students.length === 0) {
            return {
                totalMatchedStudents: 0,
                eligibleStudents: [] as Array<{
                    student_id: number;
                    campus_id: number;
                    class_id: number;
                    section_id: number | null;
                    fee_ids: number[];
                    fee_lines: Array<{ student_fee_id: number; discount_amount: number; discount_label?: string }>;
                }>,
                skippedNoFeeSchedule: [] as number[],
                skippedAlreadyIssued: [] as number[],
                skippedMissingAssignment: [] as number[],
            };
        }

        const studentIds = students.map((s) => s.cc);
        const feeDateObj = filters.fee_date ? new Date(filters.fee_date) : null;

        // Build fee query: fee_date-based (new) or month-based (legacy)
        const feeWhere: any = {
            student_id: { in: studentIds },
            ...(feeDateObj
                ? { fee_date: feeDateObj }
                : {
                      academic_year: filters.academic_year,
                      OR: [
                          { month: filters.month },
                          { target_month: filters.month },
                          { student_fee_bundles: { is: { target_month: filters.month } } },
                      ],
                  }),
        };

        const fees = await this.prisma.student_fees.findMany({
            where: feeWhere,
            select: {
                id: true,
                student_id: true,
                amount: true,
                amount_before_discount: true,
            },
        });

        interface FeeLine { student_fee_id: number; discount_amount: number; discount_label?: string; }
        const feeIdsByStudent = new Map<number, number[]>();
        const feeLinesByStudent = new Map<number, FeeLine[]>();
        for (const fee of fees) {
            const list = feeIdsByStudent.get(fee.student_id) ?? [];
            list.push(fee.id);
            feeIdsByStudent.set(fee.student_id, list);

            const lineList = feeLinesByStudent.get(fee.student_id) ?? [];
            const net = Number(fee.amount ?? 0);
            // When amount_before_discount is null there is no discount — treat gross = net
            const gross = Number(fee.amount_before_discount ?? fee.amount ?? 0);
            lineList.push({
                student_fee_id: fee.id,
                discount_amount: Math.max(0, gross - net),
            });
            feeLinesByStudent.set(fee.student_id, lineList);
        }

        // Deduplicate: fee_date-based (new) or month-based (legacy)
        const existingVouchers = await this.prisma.vouchers.findMany({
            where: {
                student_id: { in: studentIds },
                ...(feeDateObj
                    ? { fee_date: feeDateObj }
                    : { academic_year: filters.academic_year, month: filters.month }),
            },
            select: { student_id: true },
        });
        const existingVoucherStudentIds = new Set(existingVouchers.map((v) => v.student_id));

        const eligibleStudents: Array<{
            student_id: number;
            campus_id: number;
            class_id: number;
            section_id: number | null;
            fee_ids: number[];
            fee_lines: Array<{ student_fee_id: number; discount_amount: number; discount_label?: string }>;
        }> = [];
        const skippedNoFeeSchedule: number[] = [];
        const skippedAlreadyIssued: number[] = [];
        const skippedMissingAssignment: number[] = [];

        for (const student of students) {
            if (!student.campus_id || !student.class_id) {
                skippedMissingAssignment.push(student.cc);
                continue;
            }

            if (existingVoucherStudentIds.has(student.cc)) {
                skippedAlreadyIssued.push(student.cc);
                continue;
            }

            const feeIds = feeIdsByStudent.get(student.cc) ?? [];
            if (feeIds.length === 0) {
                skippedNoFeeSchedule.push(student.cc);
                continue;
            }

            eligibleStudents.push({
                student_id: student.cc,
                campus_id: student.campus_id,
                class_id: student.class_id,
                section_id: student.section_id ?? null,
                fee_ids: feeIds,
                fee_lines: feeLinesByStudent.get(student.cc) ?? feeIds.map(id => ({ student_fee_id: id, discount_amount: 0 })),
            });
        }

        // ── Batch arrear lookup ──────────────────────────────────────────────
        // Use fee_date as the cutoff; fall back to issue_date so arrears are
        // always included regardless of whether the bulk job is date- or month-based.
        const arrearCutoff = feeDateObj ?? (filters.issue_date ? new Date(filters.issue_date) : null);

        if (arrearCutoff && studentIds.length > 0) {
            const arrearFees = await this.prisma.student_fees.findMany({
                where: {
                    student_id: { in: studentIds },
                    fee_date: { lt: arrearCutoff },
                    status: { notIn: ['PAID'] as any[] },
                },
                select: {
                    id: true,
                    student_id: true,
                    amount: true,
                    amount_before_discount: true,
                    amount_paid: true,
                },
                orderBy: { fee_date: 'asc' },
            });

            for (const fee of arrearFees) {
                const amount = new Prisma.Decimal(fee.amount ?? fee.amount_before_discount ?? 0);
                const paid = new Prisma.Decimal(fee.amount_paid ?? 0);
                const outstanding = amount.sub(paid);
                if (outstanding.lte(0)) continue;

                // Prepend arrear ID (avoid double-adding if already in current month list)
                const existingIds = feeIdsByStudent.get(fee.student_id) ?? [];
                if (!existingIds.includes(fee.id)) {
                    feeIdsByStudent.set(fee.student_id, [fee.id, ...existingIds]);
                }

                // Prepend arrear fee line with discount=0 (uses outstanding via amount field)
                const existingLines = feeLinesByStudent.get(fee.student_id) ?? [];
                if (!existingLines.some(l => l.student_fee_id === fee.id)) {
                    feeLinesByStudent.set(fee.student_id, [
                        { student_fee_id: fee.id, discount_amount: 0 },
                        ...existingLines,
                    ]);
                }
            }
        }

        return {
            totalMatchedStudents,
            eligibleStudents,
            skippedNoFeeSchedule,
            skippedAlreadyIssued,
            skippedMissingAssignment,
        };
    }

    // ─── Arrears ─────────────────────────────────────────────────────────────

    /**
     * Compute all unpaid / partially-paid student_fees rows whose fee_date is
     * strictly before targetFeeDate, and which are NOT already linked as a head
     * on another active (non-PAID) voucher (to prevent double-counting).
     */
    async computeArrears(studentId: number, targetFeeDate: Date) {
        console.log(`[Arrears] Computing for Student: ${studentId}, Before: ${targetFeeDate.toISOString()}`);
        const candidates = await this.prisma.student_fees.findMany({
            where: {
                student_id: studentId,
                fee_date: { lt: targetFeeDate },
                status: { notIn: ['PAID'] as any[] },
            },
            include: {
                fee_types: true,
                voucher_heads: {
                    select: {
                        id: true,
                        vouchers: { select: { id: true, status: true } },
                    },
                },
            },
            orderBy: { fee_date: 'asc' },
        });

        console.log(`[Arrears] Found candidates: ${candidates.length}`);

        const rows: {
            student_fee_id: number;
            fee_type: string;
            fee_date: string;
            amount: string;
            amount_paid: string;
            outstanding: string;
            target_month: number;
            academic_year: string;
        }[] = [];

        let totalArrears = new Prisma.Decimal(0);
        const arrearFeeIds: number[] = [];

        for (const fee of candidates) {
            const amount = new Prisma.Decimal(fee.amount ?? fee.amount_before_discount ?? 0);
            const paid = new Prisma.Decimal(fee.amount_paid ?? 0);
            const outstanding = amount.sub(paid);

            if (outstanding.lte(0)) continue;

            // We no longer skip 'alreadyActive' fees because we want to allow users 
            // to pull unpaid historical debt into new consolidated vouchers. 
            // The 'lt: targetFeeDate' filter ensures we don't double-count current-month fees.

            totalArrears = totalArrears.add(outstanding);
            arrearFeeIds.push(fee.id);

            rows.push({
                student_fee_id: fee.id,
                fee_type: fee.fee_types?.description ?? 'Unknown',
                fee_date: fee.fee_date ? fee.fee_date.toISOString().split('T')[0] : '',
                amount: amount.toFixed(2),
                amount_paid: paid.toFixed(2),
                outstanding: outstanding.toFixed(2),
                target_month: fee.target_month,
                academic_year: fee.academic_year,
            });
        }

        console.log(`[Arrears] Final response: Total=${totalArrears}, Rows=${rows.length}, IDs=${arrearFeeIds.length}`);
        if (arrearFeeIds.length > 0 && rows.length === 0) {
            console.error('[Arrears] CRITICAL: Found IDs but generated 0 rows. Check logic.');
        }

        return {
            total_arrears: Number(totalArrears.toFixed(2)),
            arrear_fee_ids: arrearFeeIds,
            rows,
        };
    }
}
