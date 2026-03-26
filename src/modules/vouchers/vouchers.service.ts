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
                    month: dto.month,
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
                const gross = fee.amount_before_discount ?? new Prisma.Decimal(0);
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
                this.logger.error(`Failed to upload PDF for voucher ${voucher.id}: ${error.message}`);
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
        });

        return {
            filters: {
                campus_id: dto.campus_id,
                class_id: dto.class_id ?? null,
                section_id: dto.section_id ?? null,
                academic_year: dto.academic_year,
                month: dto.month,
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
                    month: dto.month,
                    precedence: 1,
                    orderedFeeIds: item.fee_ids,
                    fee_lines: item.fee_ids.map((feeId) => ({
                        student_fee_id: feeId,
                        discount_amount: 0,
                        discount_label: '',
                    })),
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
                month: dto.month,
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
            return vouchers.map((v) => this.normalizeVoucher(v));
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

        return this.normalizeVoucher(voucher);
    }

    async findByStudentCC(cc: number) {
        const vouchers = await this.prisma.vouchers.findMany({
            where: { student_id: cc },
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

            // Batch update affected student fees
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
                        const grossAmount = new Prisma.Decimal(
                            fee.amount_before_discount ?? 0,
                        );
                        const nextFeeBalance = Prisma.Decimal.max(
                            grossAmount.sub(totalDeposited),
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
                            data: { status: nextFeeStatus as any },
                        });
                    }),
                );
            }

            if (lateFeeAmount.gt(0)) {
                await tx.vouchers.update({
                    where: { id: voucherId },
                    data: {
                        late_fee_deposited: { increment: lateFeeAmount },
                    } as any,
                });
            }

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

    private normalizeVoucher(voucher: any) {
        if (!voucher) return null;
        if (voucher.status === 'PAID') return voucher;

        const remHeads = (voucher.voucher_heads || []).reduce(
            (sum, head) => sum.add(new Prisma.Decimal(head.balance as any ?? 0)),
            new Prisma.Decimal(0),
        );

        const tAfter = new Prisma.Decimal((voucher as any).total_payable_after_due ?? 0);
        const tBefore = new Prisma.Decimal((voucher as any).total_payable_before_due ?? 0);
        const depLS = new Prisma.Decimal((voucher as any).late_fee_deposited ?? 0);
        const totalLS = Prisma.Decimal.max(tAfter.sub(tBefore), 0);
        const remLS = Prisma.Decimal.max(totalLS.sub(depLS), 0);
        
        const isOverdue = new Date() > new Date(voucher.due_date);
        const remOverall = isOverdue ? remHeads.add(remLS) : remHeads;

        let computedStatus = voucher.status;
        if (remOverall.eq(0)) {
            computedStatus = 'PAID';
        } else if (isOverdue) {
            computedStatus = 'OVERDUE';
        } else {
            const anyDep = (voucher.voucher_heads || []).some(h => new Prisma.Decimal(h.amount_deposited as any ?? 0).gt(0)) || depLS.gt(0);
            computedStatus = anyDep ? 'PARTIALLY_PAID' : 'UNPAID';
        }

        return {
            ...voucher,
            status: computedStatus,
        };
    }

    private async getBulkVoucherSelection(filters: {
        campus_id: number;
        class_id?: number;
        section_id?: number;
        academic_year: string;
        month: number;
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
                }>,
                skippedNoFeeSchedule: [] as number[],
                skippedAlreadyIssued: [] as number[],
                skippedMissingAssignment: [] as number[],
            };
        }

        const studentIds = students.map((s) => s.cc);

        const fees = await this.prisma.student_fees.findMany({
            where: {
                student_id: { in: studentIds },
                academic_year: filters.academic_year,
                OR: [
                    { month: filters.month },
                    { target_month: filters.month },
                    { student_fee_bundles: { is: { target_month: filters.month } } },
                ],
            },
            select: {
                id: true,
                student_id: true,
            },
        });

        const feeIdsByStudent = new Map<number, number[]>();
        for (const fee of fees) {
            const list = feeIdsByStudent.get(fee.student_id) ?? [];
            list.push(fee.id);
            feeIdsByStudent.set(fee.student_id, list);
        }

        const existingVouchers = await this.prisma.vouchers.findMany({
            where: {
                student_id: { in: studentIds },
                academic_year: filters.academic_year,
                month: filters.month,
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
            });
        }

        return {
            totalMatchedStudents,
            eligibleStudents,
            skippedNoFeeSchedule,
            skippedAlreadyIssued,
            skippedMissingAssignment,
        };
    }
}
