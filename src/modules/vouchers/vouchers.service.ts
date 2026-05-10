import {
    BadRequestException,
    ForbiddenException,
    Injectable,
    InternalServerErrorException,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateVoucherDto } from './dto/create-voucher.dto';
import { UpdateVoucherDto } from './dto/update-voucher.dto';
import { RecordVoucherDepositDto } from './dto/record-voucher-deposit.dto';
import { SplitPartiallyPaidDto } from './dto/split-partially-paid.dto';
import { StorageService } from '../../common/storage/storage.service';
import { VoucherPdfService } from '../voucher-pdf/voucher-pdf.service';
import { getMonthYearLabel, getConsolidatedMonthsLabel, isSpecial } from '../../common/utils/academic-labels';
import { BulkVoucherLogicService } from './bulk-voucher-logic.service';
import { BatchPreviewDto } from './dto/batch-preview.dto';
import { getMonthlyFeeDates } from '../bulk-voucher-jobs/utils/bulk-date.utils';
import archiver from 'archiver';
import { PDFDocument } from 'pdf-lib';

const SPLIT_PREFIX_MAX_DB_LEN = 255;
const SF_PREFIX_MAX = 50;



const VOUCHER_INCLUDE = {
    students: {
        select: {
            cc: true,
            full_name: true,
            gr_number: true,
            gender: true,
            family_id: true,
            student_guardians: {
                where: { relationship: 'FATHER' },
                take: 1,
                include: { guardians: { select: { full_name: true } } },
            },
        },
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
                    student_fee_bundles: {
                        include: {
                            student_fees: {
                                select: { installment_id: true }
                            }
                        }
                    },
                    student_fee_installments: {
                        include: { fee_types: true }
                    },
                    discount_presets: true,
                }
            }
        }
    },
    voucher_arrear_surcharges: true,
};

@Injectable()
export class VouchersService {
    private readonly logger = new Logger(VouchersService.name);
    private static readonly missingVoucherMessage =
        'Challan not yet generated — please contact the school office.';

    constructor(
        private readonly prisma: PrismaService,
        private readonly storage: StorageService,
        private readonly pdfService: VoucherPdfService,
        private readonly bulkLogic: BulkVoucherLogicService,
    ) { }

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
            // 1.a Compute arrears to discover surcharge groups (no student_fees rows written)
            let finalOrderedFeeIds = [...(dto.orderedFeeIds ?? [])];
            let surchargeGroups: Array<{ date: Date; target_month: number; academic_year: string }> = [];

            if (dto.pre_computed_surcharge_groups) {
                surchargeGroups = dto.pre_computed_surcharge_groups;
            } else if (feeDate) {
                const arrearsInfo = await this.computeArrears(dto.student_id, feeDate, dto.waive_surcharge, tx);
                surchargeGroups = arrearsInfo.surcharge_groups;
            }

            // 1.b Fetch the fees to be included in the voucher
            const feeRecords = await tx.student_fees.findMany({
                where: {
                    id: { in: finalOrderedFeeIds },
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
                    surcharge_waived: dto.waive_surcharge || false,
                    surcharge_waived_by: dto.waived_by || null,
                },
                include: VOUCHER_INCLUDE,
            });

            // 3. Create voucher heads (snapshots of fees with current prices and discounts)
            const feeLineMap = new Map(
                (dto.fee_lines || []).map(l => [l.student_fee_id, l])
            );

            let totalBeforeDueDecimal = new Prisma.Decimal(0);
            let totalArrearsDecimal = new Prisma.Decimal(0);

            const voucherHeadsData: {
                voucher_id: number;
                student_fee_id: number;
                discount_amount: Prisma.Decimal;
                discount_label: string | null;
                net_amount: Prisma.Decimal;
                amount_deposited: number;
                balance: Prisma.Decimal;
                description_prefix: string | null;
            }[] = [];

            for (const fee of feeRecords) {
                const discountInfo = feeLineMap.get(fee.id);

                // Discount rows: net_amount is stored as negative (the sign flip happens here)
                if ((fee as any).is_discount) {
                    const discountAmount = new Prisma.Decimal(fee.amount ?? 0);
                    const negativeNet = discountAmount.negated();
                    totalBeforeDueDecimal = totalBeforeDueDecimal.add(negativeNet);

                    voucherHeadsData.push({
                        voucher_id: newVoucher.id,
                        student_fee_id: fee.id,
                        discount_amount: new Prisma.Decimal(0),
                        discount_label: null,
                        net_amount: negativeNet,
                        amount_deposited: 0,
                        balance: new Prisma.Decimal(0), // discount rows are never deposited against
                        description_prefix: null,
                    });
                    continue;
                }

                // 1. Calculate net balance after any prior partial payments.
                // Rule: net_amount = student_fees.amount - student_fees.amount_paid
                const amount = new Prisma.Decimal(fee.amount ?? 0);
                const amountPaid = new Prisma.Decimal(fee.amount_paid ?? 0);
                const netAmount = amount.sub(amountPaid);

                // 2. Skip heads that are already fully (or over-) paid
                if (netAmount.lte(0)) {
                    continue;
                }

                // 3. Keep the discount snapshot consistent.
                // discount_amount = amount_before_discount - amount
                // This ensures we show the discount that was originally granted.
                const gross = fee.amount_before_discount ?? fee.amount ?? new Prisma.Decimal(0);
                const discount = new Prisma.Decimal(gross).sub(amount);

                totalBeforeDueDecimal = totalBeforeDueDecimal.add(netAmount);

                // Surcharges are no longer in student_fees/voucher_heads.
                const isArrear = feeDate && fee.fee_date && new Date(fee.fee_date) < feeDate;
                if (isArrear) {
                    totalArrearsDecimal = totalArrearsDecimal.add(netAmount);
                }

                voucherHeadsData.push({
                    voucher_id: newVoucher.id,
                    student_fee_id: fee.id,
                    discount_amount: discount,
                    discount_label: discountInfo?.discount_label ?? null,
                    net_amount: netAmount,
                    amount_deposited: 0,
                    balance: netAmount,
                    description_prefix: (fee as any).description_prefix ?? null,
                });
            }

            // 4. Reject if every fee head is already fully paid
            if (voucherHeadsData.length === 0) {
                throw new BadRequestException(
                    'All fee heads for this date are already fully paid. No voucher needed.',
                );
            }

            await tx.voucher_heads.createMany({
                data: voucherHeadsData,
            });

            // 4. Update student_fees records to mark them as ISSUED (skip discount rows — they stay DISCOUNT)
            await Promise.all(
                feeRecords
                    .filter((fee) => !(fee as any).is_discount)
                    .map((fee) =>
                        tx.student_fees.update({
                            where: { id: fee.id },
                            data: {
                                issue_date: issueDate,
                                due_date: dueDate,
                                validity_date: validityDate,
                                precedence_override: (fee as any).fee_types?.priority_order ?? 0,
                                status: 'ISSUED' as any,
                            },
                        }),
                    ),
            );

            // 5. Update voucher with final totals derived from heads
            const lateFeeVal = dto.late_fee_charge ? (dto.late_fee_amount ?? 1000) : 0;

            // Active surcharge = 1000 per distinct arrear month, zero if waived
            const activeSurchargeTotal = (!dto.waive_surcharge && surchargeGroups.length > 0)
                ? new Prisma.Decimal(surchargeGroups.length * 1000)
                : new Prisma.Decimal(0);

            const totalBeforeDueWithSurcharge = totalBeforeDueDecimal.add(activeSurchargeTotal);
            const totalAfterDueDecimal = totalBeforeDueWithSurcharge.add(lateFeeVal);

            await tx.vouchers.update({
                where: { id: newVoucher.id },
                data: {
                    total_payable_before_due: totalBeforeDueWithSurcharge,
                    total_payable_after_due: totalAfterDueDecimal,
                    total_arrears: totalArrearsDecimal,
                },
            });

            // 5a. Write voucher_arrear_surcharges rows (one per distinct arrear month)
            if (surchargeGroups.length > 0) {
                await (tx as any).voucher_arrear_surcharges.createMany({
                    data: surchargeGroups.map(g => ({
                        voucher_id: newVoucher.id,
                        arrear_fee_date: g.date,
                        arrear_month: g.target_month ?? 0,
                        arrear_year: g.academic_year ?? '',
                        amount: new Prisma.Decimal(1000),
                        waived: dto.waive_surcharge || false,
                        waived_by: dto.waive_surcharge ? (dto.waived_by ?? null) : null,
                    })),
                } as any);
            }

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

                const supersededVoucherIds = Array.from(
                    new Set(supersededHeads.map((h) => h.voucher_id))
                );

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
        page: number = 1,
        limit: number = 50,
    ) {
        try {
            const skip = (page - 1) * limit;
            const take = limit;

            const where: Prisma.vouchersWhereInput = {
                // student_id or cc both resolve to student_id (cc is the student PK)
                ...(cc ? { student_id: cc } : studentId ? { student_id: studentId } : {}),
                ...(id ? { id } : {}),
                ...(campusId ? { campus_id: campusId } : {}),
                ...(classId ? { class_id: classId } : {}),
                ...(sectionId ? { section_id: sectionId } : {}),
                // If a specific status is requested show only that; otherwise show all.
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
            };

            const [total, vouchers, stats] = await Promise.all([
                this.prisma.vouchers.count({ where }),
                this.prisma.vouchers.findMany({
                    where,
                    include: VOUCHER_INCLUDE,
                    orderBy: [{ issue_date: 'desc' }, { id: 'desc' }],
                    skip,
                    take,
                }),
                this.prisma.vouchers.groupBy({
                    by: ['status'],
                    where: {
                        ...(cc ? { student_id: cc } : studentId ? { student_id: studentId } : {}),
                        ...(id ? { id } : {}),
                        ...(campusId ? { campus_id: campusId } : {}),
                        ...(classId ? { class_id: classId } : {}),
                        ...(sectionId ? { section_id: sectionId } : {}),
                        ...(dateFrom || dateTo ? {
                            fee_date: {
                                ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
                                ...(dateTo ? { lte: new Date(dateTo) } : {}),
                            },
                        } : {}),
                    },
                    _count: { _all: true }
                })
            ]);

            const statusStats = {
                paid: 0,
                unpaid: 0,
                overdue: 0,
                void: 0
            };

            stats.forEach(s => {
                const count = s._count._all;
                if (s.status === 'PAID') statusStats.paid += count;
                else if (s.status === 'VOID') statusStats.void += count;
                else if (s.status === 'OVERDUE') statusStats.overdue += count;
                else statusStats.unpaid += count;
            });

            return {
                items: vouchers.map((v) => this.normalizeVoucher(v)),
                meta: {
                    total,
                    ...statusStats,
                    page,
                    limit,
                    totalPages: Math.ceil(total / limit),
                },
            };
        } catch (err: any) {
            this.logger.error('findAll failed', err?.message, err?.stack);
            throw new InternalServerErrorException(
                `Voucher query failed: ${err?.message ?? 'Unknown error'}`,
            );
        }
    }



    /** Helper to prepare data for VoucherPdfService */
    private async prepareVoucherPdfData(voucher: any, paidStamp = false) {
        const monthNames = [
            'January', 'February', 'March', 'April', 'May', 'June',
            'July', 'August', 'September', 'October', 'November', 'December'
        ];

        // 1. Fetch siblings if family_id exists
        let siblings: any[] = [];
        if (voucher.students?.family_id) {
            siblings = await this.prisma.students.findMany({
                where: { family_id: voucher.students.family_id, deleted_at: null, status: 'ENROLLED' },
                include: { classes: true, sections: true }
            });
        }

        // 2. Fetch all installment fees for this student to calculate sequence numbers once
        let studentInstallmentFees = await this.prisma.student_fees.findMany({
            where: {
                student_id: voucher.student_id,
                academic_year: voucher.academic_year,
                installment_id: { not: null } as any
            },
            include: { student_fee_installments: { include: { fee_types: true } } } as any,
        });

        // Sort chronologically by academic year (starting from August)
        const getAcademicSortIndex = (m: number) => (m >= 8 ? m - 8 : m + 4);
        studentInstallmentFees.sort((a: any, b: any) => {
            const aIdx = getAcademicSortIndex(a.target_month ?? a.month ?? 8);
            const bIdx = getAcademicSortIndex(b.target_month ?? b.month ?? 8);
            return aIdx - bIdx;
        });

        // Group by installment_id for sequence lookup
        const installmentGroups = new Map<number, any[]>();
        (studentInstallmentFees as any[]).forEach(f => {
            if (f.installment_id) {
                if (!installmentGroups.has(f.installment_id)) installmentGroups.set(f.installment_id, []);
                installmentGroups.get(f.installment_id)!.push(f);
            }
        });

        // 3. Initial Mapping of Heads
        let heads = voucher.voucher_heads.map((h: any) => {
            const isSplitHead = (h.split_sequence != null && h.split_total != null);
            const sf = h.student_fees;

            // ── Discount rows ───────────────────────────────────────────────
            const isDiscountRow = sf?.is_discount === true;
            if (isDiscountRow) {
                const presetTitle = sf?.discount_presets?.title ?? 'Discount';
                const netAmount = Number(h.net_amount); // already negative

                return {
                    description: presetTitle,
                    originalDescription: presetTitle,
                    amount: 0,
                    discount: 0,
                    netAmount,
                    amountDeposited: 0,
                    balance: 0,
                    isArrear: false,
                    isSurcharge: false,
                    isDiscount: true,
                    baseDescription: presetTitle,
                    feeDate: sf?.fee_date?.toISOString().split('T')[0],
                    target_month: sf?.target_month,
                    academic_year: sf?.academic_year,
                };
            }
            // ── End discount row ────────────────────────────────────────────

            const feeTypeDesc = sf?.fee_types?.description || 'Fee';
            const prefixStr = h.description_prefix ? `${h.description_prefix} ` : '';
            const monthSuffix = sf?.target_month != null
                ? ` ${getMonthYearLabel(sf.target_month, sf.academic_year, voucher.class_id).toUpperCase()}`
                : '';

            let description = prefixStr + feeTypeDesc + monthSuffix;
            const baseDescription = prefixStr + feeTypeDesc;

            // Handle Installment Sequence (e.g. 1/6)
            // STANDALONE vs MERGED Check:
            // Standalone = student_fees.fee_type_id corresponds to the original installment's fee_type_id.
            // Merged = standalone installment was added/attached to a different head (like tuition).
            const isStandaloneInstallment = sf?.installment_id && sf.fee_type_id === sf.student_fee_installments?.fee_type_id;

            if (isStandaloneInstallment) {
                const group = installmentGroups.get(sf.installment_id) || [];
                const total = sf.student_fee_installments?.installment_count || group.length;
                const idx = group.findIndex(f => f.id === sf.id);
                if (idx !== -1) {
                    description = `${prefixStr}${feeTypeDesc} INSTALLMENTS (${idx + 1}/${total})${monthSuffix}`;
                }
            }

            // Surcharges no longer appear in voucher_heads — they live in voucher_arrear_surcharges.
            const isSurcharge = false;
            let isArrear = false;

            const cutoff = isSpecial(voucher.class_id) ? 4 : 8;
            const getAcademicSortIndex = (m: number) => m >= cutoff ? m - cutoff : m + (12 - cutoff);

            const feeDateStr = h.student_fees?.fee_date ? new Date(h.student_fees.fee_date).toISOString().slice(0, 10) : null;
            const voucherDateStr = voucher.fee_date ? new Date(voucher.fee_date).toISOString().slice(0, 10) : null;
            const sameFeeDate = feeDateStr && voucherDateStr && feeDateStr === voucherDateStr;

            if (!sameFeeDate) {
                const fMonth = h.student_fees?.target_month;
                const fYear = h.student_fees?.academic_year;
                const vMonth = voucher.month;
                const vYear = voucher.academic_year;

                if (fYear && vYear && fMonth != null && vMonth != null) {
                    if (fYear < vYear) isArrear = true;
                    else if (fYear === vYear && getAcademicSortIndex(fMonth) < getAcademicSortIndex(vMonth)) isArrear = true;
                }
                if (!isArrear && h.student_fees?.fee_date && voucher.fee_date) {
                    isArrear = new Date(h.student_fees.fee_date) < new Date(voucher.fee_date);
                }
            }

            const finalPaid = Math.max(Number(h.amount_deposited || 0), Number(h.student_fees?.amount_paid || 0));
            const netAmount = Number(h.net_amount);

            return {
                description,
                originalDescription: feeTypeDesc + monthSuffix,
                baseDescription,
                amount: isSplitHead ? Number(h.net_amount) : Math.max(Number(h.student_fees?.amount_before_discount || 0), Number(h.net_amount)),
                discount: isSplitHead ? 0 : Number(h.discount_amount || 0),
                netAmount,
                amountDeposited: finalPaid,
                balance: Math.max(netAmount - finalPaid, 0),
                isArrear,
                isSurcharge,
                feeDate: h.student_fees?.fee_date?.toISOString().split('T')[0],
                target_month: h.student_fees?.target_month,
                academic_year: h.student_fees?.academic_year,
            };
        });

        // 4. Consolidate surcharges from voucher_arrear_surcharges (not from heads)
        const nonSurcharges = heads; // all heads are now regular fees
        const surchargeRows: any[] = (voucher as any).voucher_arrear_surcharges ?? [];
        const activeSurchargeRows = surchargeRows.filter((s: any) => !s.waived);
        const consolidatedSurchargeAmt = activeSurchargeRows.reduce(
            (sum: number, s: any) => sum + Number(s.amount), 0
        );

        const cutoff = isSpecial(voucher.class_id) ? 4 : 8;
        const getMonthAbsoluteIndex = (targetMonth: number, academicYear: string) => {
            const startYear = Number((academicYear || '').split('-')[0]);
            if (!Number.isFinite(startYear)) return null;
            const calendarYear = targetMonth >= cutoff ? startYear : startYear + 1;
            return calendarYear * 12 + targetMonth;
        };

        const buildRangeLabel = (
            startMonth: number,
            startYear: string,
            endMonth: number,
            endYear: string,
        ) => {
            const start = getMonthYearLabel(startMonth, startYear, voucher.class_id).toUpperCase();
            const end = getMonthYearLabel(endMonth, endYear, voucher.class_id).toUpperCase();
            return start === end ? start : `${start} - ${end}`;
        };

        // Consolidate fee-head rows by base description and contiguous months.
        // Example: AUG, SEP, OCT -> AUG - OCT; JUN, JUL -> JUN - JUL
        const consolidatable = nonSurcharges.filter(
            (h) =>
                !h.isDiscount &&
                !h.isSurcharge &&
                h.target_month != null &&
                !!h.academic_year &&
                !!h.baseDescription,
        );
        const nonConsolidatable = nonSurcharges.filter(
            (h) =>
                h.isDiscount ||
                h.isSurcharge ||
                h.target_month == null ||
                !h.academic_year ||
                !h.baseDescription,
        );

        const groupedByDescription = new Map<string, any[]>();
        for (const head of consolidatable) {
            const key = `${head.baseDescription}|${head.isArrear ? 'AR' : 'NR'}`;
            if (!groupedByDescription.has(key)) groupedByDescription.set(key, []);
            groupedByDescription.get(key)!.push(head);
        }

        const consolidatedByRanges: any[] = [];
        for (const [, groupHeads] of groupedByDescription) {
            const sorted = [...groupHeads]
                .map((h) => ({
                    ...h,
                    __absIndex: getMonthAbsoluteIndex(h.target_month, h.academic_year),
                }))
                .filter((h) => h.__absIndex != null)
                .sort((a, b) => a.__absIndex - b.__absIndex);

            if (sorted.length === 0) continue;

            let rangeStart = sorted[0];
            let rangeEnd = sorted[0];
            let aggregate = {
                amount: Number(sorted[0].amount || 0),
                discount: Number(sorted[0].discount || 0),
                netAmount: Number(sorted[0].netAmount || 0),
                amountDeposited: Number(sorted[0].amountDeposited || 0),
                balance: Number(sorted[0].balance || 0),
            };

            for (let i = 1; i < sorted.length; i++) {
                const current = sorted[i];
                const isContiguous = current.__absIndex === rangeEnd.__absIndex + 1;

                if (isContiguous) {
                    rangeEnd = current;
                    aggregate.amount += Number(current.amount || 0);
                    aggregate.discount += Number(current.discount || 0);
                    aggregate.netAmount += Number(current.netAmount || 0);
                    aggregate.amountDeposited += Number(current.amountDeposited || 0);
                    aggregate.balance += Number(current.balance || 0);
                    continue;
                }

                consolidatedByRanges.push({
                    ...rangeStart,
                    description: `${rangeStart.baseDescription} ${buildRangeLabel(
                        rangeStart.target_month,
                        rangeStart.academic_year,
                        rangeEnd.target_month,
                        rangeEnd.academic_year,
                    )}`,
                    originalDescription: `${rangeStart.baseDescription} ${buildRangeLabel(
                        rangeStart.target_month,
                        rangeStart.academic_year,
                        rangeEnd.target_month,
                        rangeEnd.academic_year,
                    )}`,
                    amount: aggregate.amount,
                    discount: aggregate.discount,
                    netAmount: aggregate.netAmount,
                    amountDeposited: aggregate.amountDeposited,
                    balance: Math.max(aggregate.balance, 0),
                });

                rangeStart = current;
                rangeEnd = current;
                aggregate = {
                    amount: Number(current.amount || 0),
                    discount: Number(current.discount || 0),
                    netAmount: Number(current.netAmount || 0),
                    amountDeposited: Number(current.amountDeposited || 0),
                    balance: Number(current.balance || 0),
                };
            }

            consolidatedByRanges.push({
                ...rangeStart,
                description: `${rangeStart.baseDescription} ${buildRangeLabel(
                    rangeStart.target_month,
                    rangeStart.academic_year,
                    rangeEnd.target_month,
                    rangeEnd.academic_year,
                )}`,
                originalDescription: `${rangeStart.baseDescription} ${buildRangeLabel(
                    rangeStart.target_month,
                    rangeStart.academic_year,
                    rangeEnd.target_month,
                    rangeEnd.academic_year,
                )}`,
                amount: aggregate.amount,
                discount: aggregate.discount,
                netAmount: aggregate.netAmount,
                amountDeposited: aggregate.amountDeposited,
                balance: Math.max(aggregate.balance, 0),
            });
        }

        // Surcharge is not a fee head — it is shown via totalSurcharge / surchargeWaived in PDF details.
        const feeHeads = [...consolidatedByRanges, ...nonConsolidatable];

        // Consolidated month-range label for the arrears row, e.g. "ARREARS (AUG 25 – OCT 25)"
        const arrearHeadsForLabel = nonSurcharges.filter(h => h.isArrear && h.target_month != null);
        const arrearsLabel = arrearHeadsForLabel.length > 0
            ? `ARREARS (${getConsolidatedMonthsLabel(
                arrearHeadsForLabel.map(h => ({ month: h.target_month!, academicYear: h.academic_year || '' })),
                voucher.class_id,
            )})`
            : 'TOTAL ARREARS';

        const totalAmount = Number(voucher.total_payable_before_due || 0);

        // Main Label: Consolidate ALL heads in the voucher
        const headsForMainLabel = heads.filter(h => h.target_month != null);
        const monthLabel = headsForMainLabel.length > 0
            ? getConsolidatedMonthsLabel(
                headsForMainLabel.map(h => ({ month: h.target_month!, academicYear: h.academic_year || '' })),
                voucher.class_id,
            )
            : (voucher.month ? monthNames[voucher.month - 1] : (voucher.fee_date ? new Date(voucher.fee_date).toLocaleString('default', { month: 'long' }) : 'N/A'));

        const ts = Date.now();
        const filePrefix = paidStamp ? 'paid-voucher' : 'voucher';
        const key = `vouchers/${voucher.student_id}/${filePrefix}-${voucher.id}-${ts}.pdf`;
        const qrUrl = this.storage.getPublicUrl(key);

        return {
            voucherData: {
                voucherNumber: voucher.id.toString(),
                student: {
                    cc: voucher.students.cc,
                    fullName: voucher.students.full_name,
                    fatherName: voucher.students?.student_guardians?.[0]?.guardians?.full_name || 'N/A',
                    gender: voucher.students?.gender || 'N/A',
                    grNumber: voucher.students.gr_number || 'N/A',
                    className: voucher.classes?.description || 'N/A',
                    sectionName: voucher.sections?.description || 'N/A',
                    classId: voucher.class_id,
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
                totalPaid: heads.reduce((sum, h) => sum + h.amountDeposited, 0),
                outstandingBalance: Math.max(totalAmount - heads.reduce((sum, h) => sum + h.amountDeposited, 0), 0),
                lateFeeAmount: voucher.late_fee_charge ? 1000 : 0,
                qrUrl,
                paidStamp,
                showDiscount: true,
                surchargeWaived: voucher.surcharge_waived,
                totalSurcharge: surchargeRows.reduce((sum: number, s: any) => sum + Number(s.amount), 0),
                arrearsLabel,
                arrearsHistory: nonSurcharges
                    .filter(fh => fh.isArrear && !fh.isDiscount)
                    .map(fh => ({
                        date: fh.feeDate || 'N/A',
                        head: fh.originalDescription,
                        amount: fh.netAmount.toLocaleString(),
                        totalAmount: fh.netAmount.toLocaleString(),
                        target_month: fh.target_month,
                        academic_year: fh.academic_year,
                    })),
                installmentsHistory: studentInstallmentFees
                    .filter(f => {
                        const isStandalone = (f as any).installment_id && f.fee_type_id === (f as any).student_fee_installments?.fee_type_id;
                        return isStandalone && f.status !== 'PAID' && !voucher.voucher_heads.some((vh: any) => vh.student_fee_id === f.id);
                    })
                    .map((f: any) => {
                        const group = installmentGroups.get((f as any).installment_id!) || [];
                        const total = f.student_fee_installments?.installment_count || group.length;
                        const idx = group.findIndex(sf => sf.id === f.id);
                        const feeType = f.student_fee_installments?.fee_types?.description || 'Fee';
                        return {
                            head: `${feeType} INSTALLMENTS (${idx + 1}/${total})`,
                            month: f.target_month ? monthNames[f.target_month - 1].slice(0, 3).toUpperCase() : 'N/A',
                            amount: Number(f.amount || 0).toLocaleString(),
                        };
                    }),
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
                OR: [
                    { status: { not: 'VOID' } },
                    {
                        status: 'VOID',
                        voucher_heads: {
                            some: {
                                amount_deposited: { gt: 0 }
                            }
                        }
                    }
                ],
                ...(familyId ? { students: { family_id: familyId } } : {})
            },
            include: VOUCHER_INCLUDE,
            orderBy: { issue_date: 'asc' },
        });
        return vouchers.map((v) => this.normalizeVoucher(v));
    }

    async resolveVoucherForParentByMonth(
        studentCc: number,
        familyId: number,
        academicYear: string,
        targetMonth: number,
    ) {
        const student = await this.prisma.students.findFirst({
            where: {
                cc: studentCc,
                family_id: familyId,
                deleted_at: null,
            },
            select: { cc: true },
        });

        if (!student) {
            throw new ForbiddenException(
                `Student #${studentCc} not linked to your family`,
            );
        }

        const voucher = await this.prisma.vouchers.findFirst({
            where: {
                student_id: studentCc,
                status: { not: 'VOID' },
                OR: [
                    { academic_year: academicYear },
                    {
                        voucher_heads: {
                            some: {
                                student_fees: {
                                    academic_year: academicYear,
                                },
                            },
                        },
                    },
                ],
                AND: [
                    {
                        OR: [
                            { month: targetMonth },
                            {
                                voucher_heads: {
                                    some: {
                                        student_fees: {
                                            target_month: targetMonth,
                                        },
                                    },
                                },
                            },
                        ],
                    },
                ],
            },
            include: VOUCHER_INCLUDE,
            orderBy: [{ issue_date: 'desc' }, { id: 'desc' }],
        });

        if (!voucher) {
            return {
                exists: false,
                message: VouchersService.missingVoucherMessage,
            };
        }

        return {
            exists: true,
            voucher: this.normalizeVoucher(voucher),
        };
    }

    async update(id: number, dto: UpdateVoucherDto) {
        await this.findOne(id); // ensure it exists

        const needsPdfInvalidation =
            dto.issue_date ||
            dto.due_date ||
            dto.validity_date !== undefined ||
            dto.status !== undefined ||
            dto.late_fee_charge !== undefined ||
            dto.bank_account_id ||
            dto.section_id !== undefined;

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
                ...(needsPdfInvalidation ? { pdf_url: null } : {}),
            },
            include: VOUCHER_INCLUDE,
        });
    }

    async recordDeposit(voucherId: number, dto: RecordVoucherDepositDto) {
        const depositAmount = new Prisma.Decimal(dto.amount);
        const lateFeeAmount = new Prisma.Decimal(dto.late_fee ?? 0);
        const distributionEntries = Object.entries(dto.distributions ?? {});

        // ── Parse surcharge allocations ──────────────────────────────────────
        const parsedSurchargeAllocations = (dto.surcharge_allocations ?? []).map(s => {
            const surchargeId = Number(s.surcharge_id);
            const amount = new Prisma.Decimal(s.amount ?? 0);
            if (!Number.isInteger(surchargeId) || surchargeId <= 0) {
                throw new BadRequestException(`Invalid surcharge id '${s.surcharge_id}' in surcharge_allocations.`);
            }
            if (amount.lt(0)) {
                throw new BadRequestException(`Surcharge allocation amount cannot be negative for surcharge #${surchargeId}.`);
            }
            return { surchargeId, amount };
        });
        const surchargesTotal = parsedSurchargeAllocations.reduce(
            (sum, s) => sum.add(s.amount),
            new Prisma.Decimal(0),
        );

        if (distributionEntries.length === 0 && lateFeeAmount.eq(0) && surchargesTotal.eq(0)) {
            throw new BadRequestException(
                'Provide at least one voucher head distribution, surcharge allocation, or late fee amount.',
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
        const distributedTotal = headsTotal.add(lateFeeAmount).add(surchargesTotal);

        if (!distributedTotal.eq(depositAmount)) {
            throw new BadRequestException(
                'Deposit amount must equal the sum of distributions, surcharge allocations, and late fee.',
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

        if (voucher.status === 'PAID') {
            throw new BadRequestException(
                `Voucher #${voucherId} is already fully paid.`,
            );
        }

        const voucherHeadMap = new Map(
            voucher.voucher_heads.map((h) => [h.id, h]),
        );

        for (const { headId } of parsedDistributions) {
            const head = voucherHeadMap.get(headId);
            if (!head) {
                throw new BadRequestException(
                    `Voucher head #${headId} does not belong to voucher #${voucherId}.`,
                );
            }
        }

        // ── Pre-validate surcharge allocations (Initial check) ──────────────
        if (parsedSurchargeAllocations.length > 0) {
            const voucherSurcharges = await (this.prisma as any).voucher_arrear_surcharges.findMany({
                where: { voucher_id: voucherId, id: { in: parsedSurchargeAllocations.map(s => s.surchargeId) } },
            });
            const surchargeMap = new Map((voucherSurcharges as any[]).map(s => [s.id, s]));
            for (const { surchargeId, amount } of parsedSurchargeAllocations) {
                const surcharge = surchargeMap.get(surchargeId);
                if (!surcharge) {
                    throw new BadRequestException(`Surcharge #${surchargeId} does not belong to voucher #${voucherId}.`);
                }
                if (surcharge.waived) {
                    throw new BadRequestException(`Surcharge #${surchargeId} has been waived and cannot receive a payment.`);
                }
                const remaining = new Prisma.Decimal(surcharge.amount).sub(
                    new Prisma.Decimal(surcharge.amount_paid ?? 0),
                );
                if (amount.gt(remaining)) {
                    throw new BadRequestException(
                        `Surcharge #${surchargeId} allocation (${amount}) exceeds its remaining balance (${remaining}).`,
                    );
                }
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

        // 2. LEAN TRANSACTION
        await this.prisma.$transaction(
            async (tx) => {
                const distributionHeadIds = parsedDistributions.map((d) => d.headId);
                const txHeads = await tx.voucher_heads.findMany({
                    where: {
                        voucher_id: voucherId,
                        id: { in: distributionHeadIds },
                    },
                    select: {
                        id: true,
                        student_fee_id: true,
                    },
                });

                const txHeadMap = new Map(txHeads.map((head) => [head.id, head]));

                for (const { headId } of parsedDistributions) {
                    if (!txHeadMap.has(headId)) {
                        throw new BadRequestException(
                            `Voucher head #${headId} does not belong to voucher #${voucherId}.`,
                        );
                    }
                }

                const affectedStudentFeeIds: number[] = Array.from(
                    new Set(
                        txHeads
                            .map((head) => head.student_fee_id)
                            .filter(Boolean) as number[],
                    )
                );

                const studentFees = affectedStudentFeeIds.length
                    ? await tx.student_fees.findMany({
                        where: { id: { in: affectedStudentFeeIds } },
                        select: {
                            id: true,
                            amount: true,
                            amount_paid: true,
                            description_prefix: true,
                        } as any,
                    })
                    : [];
                const studentFeeMap = new Map<number, any>((studentFees as any[]).map((fee) => [fee.id, fee]));

                for (const { headId, amount } of parsedDistributions) {
                    const head = txHeadMap.get(headId)!;

                    if (!head.student_fee_id) {
                        throw new BadRequestException(
                            `Voucher head #${headId} is not linked to a student fee.`,
                        );
                    }

                    const fee = studentFeeMap.get(head.student_fee_id);
                    if (!fee) {
                        throw new BadRequestException(
                            `Student fee #${head.student_fee_id} not found for voucher head #${headId}.`,
                        );
                    }

                    const allowedAmount = Prisma.Decimal.max(
                        new Prisma.Decimal(fee.amount ?? 0).sub(
                            new Prisma.Decimal(fee.amount_paid ?? 0),
                        ),
                        new Prisma.Decimal(0),
                    );

                    if (amount.gt(allowedAmount)) {
                        throw new BadRequestException(
                            `Distribution for head #${headId} exceeds its balance.`,
                        );
                    }
                }

                // ── Step A: Update voucher_heads balances ──────────────────────
                await Promise.all(
                    parsedDistributions.map(({ headId, amount }) => {
                        if (amount.eq(0)) return Promise.resolve();
                        return tx.voucher_heads.update({
                            where: { id: headId },
                            data: {
                                amount_deposited: { increment: amount },
                            },
                        });
                    }),
                );

                if (distributionHeadIds.length > 0) {
                    await tx.$executeRaw`
                    UPDATE voucher_heads
                    SET balance = GREATEST(
                        COALESCE(net_amount, 0) - COALESCE(amount_deposited, 0),
                        0
                    )
                    WHERE id IN (${Prisma.join(distributionHeadIds)})
                `;
                }

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
                        const head = txHeadMap.get(headId)!;
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

                // ── Step B2: Write surcharge allocations ─────────────────────
                for (const { surchargeId, amount } of parsedSurchargeAllocations) {
                    if (amount.eq(0)) continue;

                    // Re-validate inside transaction with lock
                    const surcharge = await (tx as any).voucher_arrear_surcharges.findUnique({
                        where: { id: surchargeId },
                    });

                    if (!surcharge) throw new BadRequestException(`Surcharge #${surchargeId} not found.`);

                    const remaining = new Prisma.Decimal(surcharge.amount).sub(
                        new Prisma.Decimal(surcharge.amount_paid ?? 0),
                    );

                    if (amount.gt(remaining)) {
                        throw new BadRequestException(
                            `Surcharge #${surchargeId} allocation (${amount}) exceeds its remaining balance (${remaining}). (Tx Error)`,
                        );
                    }

                    await tx.deposit_allocations.create({
                        data: {
                            deposit_id: depositRecord.id,
                            voucher_id: voucherId,
                            surcharge_id: surchargeId,
                            student_fee_id: null,
                            amount,
                            type: 'SURCHARGE',
                        } as any,
                    });
                    await (tx as any).voucher_arrear_surcharges.update({
                        where: { id: surchargeId },
                        data: { amount_paid: { increment: amount } },
                    });
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

                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const dueDate = new Date(refreshed.due_date);
                dueDate.setHours(0, 0, 0, 0);
                const isOverdue = today > dueDate;

                // Rule: If all main heads are paid, the voucher is marked as PAID.
                const allMainHeadsPaid = remainingHeads.lte(0);

                const anyHeadDeposited = refreshed.voucher_heads.some((h) =>
                    new Prisma.Decimal(h.amount_deposited as any ?? 0).gt(0),
                );

                const surcharges = await (tx as any).voucher_arrear_surcharges.findMany({
                    where: { voucher_id: voucherId, waived: false }
                });
                const surchargeRem = surcharges.reduce(
                    (sum: Prisma.Decimal, s: any) => sum.add(new Prisma.Decimal(s.amount).sub(new Prisma.Decimal(s.amount_paid ?? 0))),
                    new Prisma.Decimal(0)
                );
                const anySurchargeDep = surcharges.some((s: any) => new Prisma.Decimal(s.amount_paid ?? 0).gt(0));

                const hasAnyDeposit = anyHeadDeposited || depositedLS.gt(0) || anySurchargeDep;
                const allSurchargesPaid = surchargeRem.lte(0);

                let nextVoucherStatus = refreshed.status ?? 'UNPAID';
                if (allMainHeadsPaid && allSurchargesPaid) {
                    nextVoucherStatus = 'PAID';
                } else if (hasAnyDeposit) {
                    nextVoucherStatus = 'PARTIALLY_PAID';
                } else if (isOverdue) {
                    nextVoucherStatus = 'OVERDUE';
                } else {
                    nextVoucherStatus = 'UNPAID';
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

    /**
     * Clear a specific deposit against a specific voucher.
     * Performs a destructive reversal:
     * 1. Finds all deposit_allocations for this deposit_id AND voucher_id
     * 2. For each allocation with a student_fee_id, resets that student_fees row
     * 3. Deletes the deposit_allocations for this voucher
     * 4. If the parent deposits record has no remaining allocations, deletes it
     * 5. Resets voucher status to UNPAID and clears late_fee_deposited
     * 6. Resets voucher_heads cache (amount_deposited to 0, balance to net_amount)
     *
     * Edge case: If a deposit covered multiple vouchers, only allocations for the
     * specified voucher are deleted. The deposits record only gets deleted if no
     * allocations remain after this targeted deletion.
     */
    async clearDeposit(voucherId: number, depositId: number) {
        const voucher = await this.prisma.vouchers.findUnique({
            where: { id: voucherId },
        });

        if (!voucher) {
            throw new NotFoundException(`Voucher with ID ${voucherId} not found`);
        }

        if (voucher.status === 'PAID') {
            throw new BadRequestException(
                `Cannot clear deposit for a PAID voucher. The voucher status must be manually reset first.`,
            );
        }

        await this.prisma.$transaction(async (tx) => {
            // 1. Find all deposit_allocations for this deposit_id AND this voucher_id
            const allocations = await tx.deposit_allocations.findMany({
                where: { deposit_id: depositId, voucher_id: voucherId },
            });

            // 2. For each allocation that has a student_fee_id, reset that student_fees row
            for (const alloc of allocations.filter(a => a.student_fee_id)) {
                await tx.student_fees.update({
                    where: { id: alloc.student_fee_id! },
                    data: {
                        amount_paid: 0,
                        status: 'ISSUED',
                        issue_date: null,
                        due_date: null,
                        validity_date: null,
                    } as any,
                });
            }

            // 3. Delete the deposit_allocations for this voucher
            await tx.deposit_allocations.deleteMany({
                where: { deposit_id: depositId, voucher_id: voucherId },
            });

            // 4. Check if the parent deposits record now has any remaining allocations
            const remainingAllocations = await tx.deposit_allocations.count({
                where: { deposit_id: depositId },
            });

            // 5. If orphaned, delete the deposits record too
            if (remainingAllocations === 0) {
                await tx.deposits.delete({ where: { id: depositId } });
            }

            // 6. Reset voucher status to UNPAID and clear late_fee_deposited
            await tx.vouchers.update({
                where: { id: voucherId },
                data: {
                    status: 'UNPAID',
                    late_fee_deposited: 0,
                } as any,
            });

            // 7. Also reset voucher_heads cache (use raw query for column reference)
            await (tx as any).$executeRawUnsafe(
                `UPDATE voucher_heads SET amount_deposited = 0, balance = net_amount WHERE voucher_id = $1`,
                voucherId
            );
        }, { timeout: 15000 });

        // Final full fetch
        return this.findOne(voucherId);
    }

    /**
     * Generate a voucher PDF server-side, upload it, persist pdf_url, and return the URL.
     * Used by both the single-voucher challan flow and the PAID-stamp download on the vouchers list.
     */
    async generatePdf(voucherId: number, showDiscount = true, paidStamp = false) {
        const voucher = await this.prisma.vouchers.findUnique({
            where: { id: voucherId },
            include: VOUCHER_INCLUDE,
        });

        if (!voucher) throw new NotFoundException(`Voucher ${voucherId} not found`);

        // Enforce paid stamp if the voucher is fully paid
        const isActuallyPaid = voucher.status === 'PAID';
        const finalPaidStamp = paidStamp || isActuallyPaid;

        const { voucherData, key } = await this.prepareVoucherPdfData(voucher, finalPaidStamp);
        voucherData.showDiscount = showDiscount;

        const pdfBuffer = await this.pdfService.generateVoucherPdf(voucherData);
        const pdfUrl = await this.storage.upload(key, pdfBuffer);
        await this.prisma.vouchers.update({ where: { id: voucherId }, data: { pdf_url: pdfUrl } });

        return { pdf_url: pdfUrl };
    }

    /**
     * Like generatePdf() but returns the raw buffer alongside the URL.
     * Used by bulk-voucher jobs to collect individual buffers for merging.
     */
    async generatePdfBuffer(voucherId: number, paidStamp = false): Promise<{ buffer: Buffer; url: string }> {
        const voucher = await this.prisma.vouchers.findUnique({
            where: { id: voucherId },
            include: VOUCHER_INCLUDE,
        });

        if (!voucher) throw new NotFoundException(`Voucher ${voucherId} not found`);

        const finalPaidStamp = paidStamp || voucher.status === 'PAID';
        const { voucherData, key } = await this.prepareVoucherPdfData(voucher, finalPaidStamp);
        const buffer = await this.pdfService.generateVoucherPdf(voucherData);
        const url = await this.storage.upload(key, buffer);
        await this.prisma.vouchers.update({ where: { id: voucherId }, data: { pdf_url: url } });

        return { buffer, url };
    }

    async batchExport(voucherIds: number[]): Promise<Buffer> {
        const archive = archiver('zip', { zlib: { level: 9 } });
        const chunks: any[] = [];

        return new Promise(async (resolve, reject) => {
            archive.on('data', (chunk: any) => chunks.push(chunk));
            archive.on('end', () => resolve(Buffer.concat(chunks)));
            archive.on('error', (err: any) => reject(err));

            const BATCH_SIZE = 5;
            for (let i = 0; i < voucherIds.length; i += BATCH_SIZE) {
                const batch = voucherIds.slice(i, i + BATCH_SIZE);
                await Promise.all(batch.map(async (id) => {
                    try {
                        const { buffer } = await this.generatePdfBuffer(id);
                        const voucher = await this.prisma.vouchers.findUnique({
                            where: { id },
                            select: { student_id: true, academic_year: true, month: true }
                        });
                        const monthNamesShort = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
                        const monthStr = voucher?.month ? monthNamesShort[voucher.month - 1] : 'UNK';
                        const filename = `Voucher-${id}-CC${voucher?.student_id}-${voucher?.academic_year}-${monthStr}.pdf`;
                        archive.append(buffer, { name: filename });
                    } catch (err) {
                        this.logger.error(`Failed to add voucher ${id} to zip: ${err.message}`);
                    }
                }));
            }
            archive.finalize();
        });
    }

    async batchMerge(voucherIds: number[]): Promise<Buffer> {
        const mergedPdf = await PDFDocument.create();

        const BATCH_SIZE = 5;
        for (let i = 0; i < voucherIds.length; i += BATCH_SIZE) {
            const batch = voucherIds.slice(i, i + BATCH_SIZE);
            const results = await Promise.all(batch.map(async (id) => {
                try {
                    const { buffer } = await this.generatePdfBuffer(id);
                    return buffer;
                } catch (err) {
                    this.logger.error(`Failed to generate PDF for voucher ${id}: ${err.message}`);
                    return null;
                }
            }));

            for (const buffer of results) {
                if (!buffer) continue;
                const pdf = await PDFDocument.load(buffer);
                const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
                copiedPages.forEach((page: any) => mergedPdf.addPage(page));
            }
        }

        return Buffer.from(await mergedPdf.save());
    }

    private stripSplitPrefix(raw: string | null | undefined): string {
        if (!raw) return '';
        const s = raw.trim();
        if (s.startsWith('PARTIAL PAYMENT OF ')) return s.slice('PARTIAL PAYMENT OF '.length).trim();
        if (s.startsWith('BALANCE PAYMENT OF ')) return s.slice('BALANCE PAYMENT OF '.length).trim();
        if (s === 'PARTIAL PAYMENT OF' || s === 'BALANCE PAYMENT OF') return '';
        return s;
    }

    // Build the new prefix for the paid / balance side.
    // Reads from student_fees.description_prefix (source of truth), strips any old split
    // prefix first so re-splitting never stacks.
    // student_fees.description_prefix is VarChar(50).
    private buildSplitPrefixes(sfDescriptionPrefix: string | null | undefined): {
        prefixPaid: string;
        prefixBalance: string;
    } {
        const base = this.stripSplitPrefix(sfDescriptionPrefix); // e.g. "" or "TRANSPORT FEE" (if custom)
        const prefixPaid = base
            ? `PARTIAL PAYMENT OF ${base}`.slice(0, SF_PREFIX_MAX)
            : 'PARTIAL PAYMENT OF';
        const prefixBalance = base
            ? `BALANCE PAYMENT OF ${base}`.slice(0, SF_PREFIX_MAX)
            : 'BALANCE PAYMENT OF';
        return { prefixPaid, prefixBalance };
    }



    /**
     * Split a PARTIALLY_PAID voucher into a PAID voucher and an UNPAID balance voucher.
     *
     * Per head (linked student_fees row):
     * - PARTIALLY_PAID (Case A): split student_fees into paid + balance rows; optional
     *   description_prefix lines use "PARTIAL PAYMENT OF …" / "BALANCE PAYMENT OF …" unless
     *   the fee type label is already prefixed.
     * - PAID / ISSUED / NOT_ISSUED (Case B): keep student_fees; no description_prefix;
     *   route fully paid lines to the PAID voucher and outstanding lines to the UNPAID voucher.
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

        const allHeads = await this.prisma.voucher_heads.findMany({
            where: { voucher_id: voucherId },
            include: { student_fees: { include: { fee_types: true } } },
        });

        if (allHeads.length === 0) {
            throw new BadRequestException('This voucher has no fee heads to split.');
        }

        const sortedHeads = [...allHeads].sort((a, b) => a.id - b.id);

        type HeadInsert = {
            student_fee_id: number;
            discount_amount: Prisma.Decimal;
            discount_label: string | null;
            net_amount: Prisma.Decimal;
            amount_deposited: Prisma.Decimal;
            balance: Prisma.Decimal;
            // This is set from student_fees.description_prefix — always the source of truth.
            description_prefix: string | null;
        };

        const paidHeadRows: HeadInsert[] = [];
        const unpaidHeadRows: HeadInsert[] = [];

        for (const h of sortedHeads) {
            const sf = h.student_fees;
            if (!sf) {
                throw new BadRequestException(`Voucher head #${h.id} has no linked student_fees row.`);
            }

            const dep = new Prisma.Decimal(h.amount_deposited as any ?? 0);
            const canon = new Prisma.Decimal(sf.amount ?? sf.amount_before_discount ?? 0);
            const paidOnFee = new Prisma.Decimal(sf.amount_paid ?? 0);
            const outstanding = Prisma.Decimal.max(canon.sub(paidOnFee), new Prisma.Decimal(0));
            const balanceFromHead = Prisma.Decimal.max(canon.sub(dep), new Prisma.Decimal(0));

            if (sf.status === 'PARTIALLY_PAID') {
                if (dep.lte(0)) {
                    throw new BadRequestException(
                        `Cannot split head #${h.id}: student fee #${sf.id} is PARTIALLY_PAID but this head has no deposit.`,
                    );
                }
                const depPaidDiff = dep.sub(paidOnFee).abs();
                if (depPaidDiff.gt(0.05)) {
                    throw new BadRequestException(
                        `Cannot split head #${h.id}: head deposit (${dep.toFixed(2)}) does not match ` +
                        `student_fees.amount_paid (${paidOnFee.toFixed(2)}). Reconcile before splitting.`,
                    );
                }
                if (balanceFromHead.lte(0)) {
                    throw new BadRequestException(
                        `Cannot split head #${h.id}: student fee #${sf.id} is marked PARTIALLY_PAID but has no outstanding balance.`,
                    );
                }

                // ── Read from student_fees (source of truth), NOT from h.description_prefix.
                // buildSplitPrefixes strips any existing PARTIAL/BALANCE prefix first,
                // so splitting twice never produces "PARTIAL PAYMENT OF BALANCE PAYMENT OF".
                const { prefixPaid, prefixBalance } = this.buildSplitPrefixes((sf as any).description_prefix);

                paidHeadRows.push({
                    student_fee_id: sf.id,   // will be replaced by resolveSfId in tx
                    discount_amount: new Prisma.Decimal(0),
                    discount_label: h.discount_label,
                    net_amount: dep,
                    amount_deposited: dep,
                    balance: new Prisma.Decimal(0),
                    description_prefix: prefixPaid,
                });
                unpaidHeadRows.push({
                    student_fee_id: sf.id,   // will be replaced by resolveSfId in tx
                    discount_amount: new Prisma.Decimal(0),
                    discount_label: h.discount_label,
                    net_amount: balanceFromHead,
                    amount_deposited: new Prisma.Decimal(0),
                    balance: balanceFromHead,
                    description_prefix: prefixBalance,
                } as any);

            } else if (sf.status === 'PAID') {
                const linePaid = dep.gt(0) ? dep : new Prisma.Decimal(h.net_amount ?? 0);
                if (linePaid.lte(0)) {
                    throw new BadRequestException(
                        `Cannot place head #${h.id} on the paid voucher: no deposited or net amount.`,
                    );
                }
                // Read prefix from student_fees — source of truth.
                paidHeadRows.push({
                    student_fee_id: sf.id,
                    discount_amount: new Prisma.Decimal(h.discount_amount ?? 0),
                    discount_label: h.discount_label,
                    net_amount: linePaid,
                    amount_deposited: linePaid,
                    balance: new Prisma.Decimal(0),
                    description_prefix: (sf as any).description_prefix ?? null,
                });

            } else if (sf.status === 'ISSUED' || sf.status === 'NOT_ISSUED') {
                const netOutstanding = outstanding.gt(0)
                    ? outstanding
                    : new Prisma.Decimal(h.net_amount ?? 0);
                if (netOutstanding.lte(0)) {
                    throw new BadRequestException(
                        `Cannot place head #${h.id} on the unpaid voucher: no outstanding amount.`,
                    );
                }
                // Read prefix from student_fees — source of truth.
                unpaidHeadRows.push({
                    student_fee_id: sf.id,
                    discount_amount: new Prisma.Decimal(h.discount_amount ?? 0),
                    discount_label: h.discount_label,
                    net_amount: netOutstanding,
                    amount_deposited: new Prisma.Decimal(0),
                    balance: netOutstanding,
                    description_prefix: (sf as any).description_prefix ?? null,
                });

            } else {
                throw new BadRequestException(
                    `Voucher head #${h.id}: unsupported student_fees.status ${sf.status} for split.`,
                );
            }
        }

        if (paidHeadRows.length === 0) {
            throw new BadRequestException('No lines could be placed on the paid voucher.');
        }
        if (unpaidHeadRows.length === 0) {
            throw new BadRequestException('No lines could be placed on the unpaid voucher.');
        }

        const issueDate = new Date(dto.issue_date);
        const dueDate = new Date(dto.due_date);
        const validityDate = dto.validity_date ? new Date(dto.validity_date) : null;

        const lateFeeVal = original.late_fee_charge ? new Prisma.Decimal(1000) : new Prisma.Decimal(0);
        const paidTotal = paidHeadRows.reduce((s, r) => s.add(r.net_amount), new Prisma.Decimal(0));
        const unpaidTotal = unpaidHeadRows.reduce((s, r) => s.add(r.net_amount), new Prisma.Decimal(0));

        const { paidVoucher, unpaidVoucher } = await this.prisma.$transaction(async (tx) => {

            // ── Step 1: For every PARTIALLY_PAID student_fees row, create two new rows
            //           (paid side + balance side) and delete the original.
            //           The map now carries the correct prefixes derived above.
            const splitReplacement = new Map<number, {
                paidId: number;
                unpaidId: number;
                prefixPaid: string;
                prefixBalance: string;
            }>();

            const partialFeeIds = Array.from(
                new Set(
                    sortedHeads
                        .filter((h) => h.student_fees?.status === 'PARTIALLY_PAID')
                        .map((h) => h.student_fee_id),
                )
            );

            for (const oldFeeId of partialFeeIds) {
                const head = sortedHeads.find((h) => h.student_fee_id === oldFeeId)!;
                const oldFee = head.student_fees!;

                // ── Use the TOTAL paid on the fee row (from all vouchers) as the paid portion,
                //    ensuring the balance row is strictly (Original - Total Paid).
                const totalPaidOnFee = new Prisma.Decimal(oldFee.amount_paid as any ?? 0);
                const canonAmt = new Prisma.Decimal(oldFee.amount ?? oldFee.amount_before_discount ?? 0);
                const grossOld = new Prisma.Decimal(oldFee.amount_before_discount ?? oldFee.amount ?? 0);

                const paidGross = canonAmt.gt(0)
                    ? grossOld.mul(totalPaidOnFee).div(canonAmt)
                    : totalPaidOnFee;
                const unpaidGross = Prisma.Decimal.max(grossOld.sub(paidGross), new Prisma.Decimal(0));
                const unpaidNet = Prisma.Decimal.max(canonAmt.sub(totalPaidOnFee), new Prisma.Decimal(0));

                // ── Compute prefixes from student_fees source of truth
                const { prefixPaid, prefixBalance } = this.buildSplitPrefixes((oldFee as any).description_prefix);

                // ── To avoid unique constraint conflicts (student_id, fee_type_id, fee_date)
                //    while keeping foreign keys intact, we first NULL the fee_date of the old row.
                //    This "makes room" for the new PAID row without deleting the old one yet.
                await tx.student_fees.update({
                    where: { id: oldFeeId },
                    data: { fee_date: null },
                });

                const paidSf = await tx.student_fees.create({
                    data: {
                        student_id: oldFee.student_id,
                        fee_type_id: oldFee.fee_type_id,
                        month: oldFee.month,
                        academic_year: oldFee.academic_year,
                        precedence_override: oldFee.precedence_override,
                        issue_date: oldFee.issue_date,
                        due_date: oldFee.due_date,
                        validity_date: oldFee.validity_date,
                        status: 'PAID',
                        amount_before_discount: paidGross,
                        target_month: oldFee.target_month,
                        amount: totalPaidOnFee,
                        bundle_id: oldFee.bundle_id,
                        fee_date: oldFee.fee_date, // Keep original date for the PAID portion
                        amount_paid: totalPaidOnFee,
                        description_prefix: prefixPaid,
                    } as any,
                });

                const unpaidSf = await tx.student_fees.create({
                    data: {
                        student_id: oldFee.student_id,
                        fee_type_id: oldFee.fee_type_id,
                        month: oldFee.month,
                        academic_year: oldFee.academic_year,
                        precedence_override: oldFee.precedence_override,
                        issue_date: oldFee.issue_date,
                        due_date: oldFee.due_date,
                        validity_date: oldFee.validity_date,
                        status: 'ISSUED',
                        amount_before_discount: unpaidGross,
                        target_month: oldFee.target_month,
                        amount: unpaidNet,
                        bundle_id: oldFee.bundle_id,
                        fee_date: null, // NULL date prevents unique constraint conflict with the paid row
                        amount_paid: new Prisma.Decimal(0),
                        description_prefix: prefixBalance,
                    },
                });

                // ── Re-link ALL deposit allocations (from all vouchers) to the new paid fee row.
                await tx.deposit_allocations.updateMany({
                    where: { student_fee_id: oldFeeId },
                    data: { student_fee_id: paidSf.id },
                });

                // ── Re-link ALL other voucher heads to the new paid fee row (so they don't orphan).
                //    Heads on the current voucherId will be deleted in Step 2 anyway.
                await tx.voucher_heads.updateMany({
                    where: { student_fee_id: oldFeeId, NOT: { voucher_id: voucherId } },
                    data: { student_fee_id: paidSf.id },
                });

                splitReplacement.set(oldFeeId, {
                    paidId: paidSf.id,
                    unpaidId: unpaidSf.id,
                    prefixPaid,
                    prefixBalance,
                });
            }

            // ── Step 2: Delete all heads on the original voucher (they'll be re-created
            //           under the two new vouchers).
            await tx.voucher_heads.deleteMany({ where: { voucher_id: voucherId } });

            // ── Step 3: Now we can safely delete the original student fees since
            //           all references (allocations, heads) have been migrated or deleted.
            if (partialFeeIds.length > 0) {
                await tx.student_fees.deleteMany({
                    where: { id: { in: partialFeeIds } },
                });
            }

            // ── Step 3: Helper — resolve student_fee_id for the new split rows.
            const resolveSfId = (oldId: number, side: 'paid' | 'unpaid'): number => {
                const rep = splitReplacement.get(oldId);
                if (!rep) return oldId;
                return side === 'paid' ? rep.paidId : rep.unpaidId;
            };

            // ── Step 4: Helper — resolve the correct description_prefix for a head row.
            //    For PARTIALLY_PAID rows that were split, use the prefix stored in the map
            //    (which came from student_fees, with no stacking).
            //    For other rows (PAID/ISSUED), the prefix is already on the row itself
            //    (read from sf.description_prefix in the loop above).
            const resolvePrefix = (row: HeadInsert, side: 'paid' | 'unpaid'): string | null => {
                const rep = splitReplacement.get(row.student_fee_id);
                if (!rep) return row.description_prefix;   // PAID/ISSUED — already correct
                return side === 'paid' ? rep.prefixPaid : rep.prefixBalance;
            };

            const feeRef = allHeads[0]?.student_fees;
            const targetMonth = feeRef?.target_month ?? original.month;
            const targetYear = feeRef?.academic_year ?? original.academic_year;
            const targetFeeDate = feeRef?.fee_date ?? original.fee_date;

            const commonFields = {
                student_id: original.student_id,
                campus_id: original.campus_id,
                class_id: original.class_id,
                section_id: original.section_id,
                bank_account_id: original.bank_account_id,
                academic_year: targetYear,
                month: targetMonth,
                fee_date: targetFeeDate,
                late_fee_charge: original.late_fee_charge,
            };

            // ── Step 5: Compute arrear totals for each split side.
            const getArrearTotal = (rows: HeadInsert[]) => {
                let arrears = new Prisma.Decimal(0);
                for (const row of rows) {
                    const head = sortedHeads.find(h => h.student_fee_id === row.student_fee_id);
                    const fee = head?.student_fees;
                    if (!fee) continue;
                    const isArrear = fee.fee_date
                        && original.fee_date
                        && new Date(fee.fee_date) < new Date(original.fee_date);
                    if (isArrear) arrears = arrears.add(row.net_amount);
                }
                return arrears;
            };

            const paidArrears = getArrearTotal(paidHeadRows);
            const unpaidArrears = getArrearTotal(unpaidHeadRows);

            // ── Step 6: Create the two new vouchers.
            const paid = await tx.vouchers.create({
                data: {
                    ...commonFields,
                    issue_date: original.issue_date,
                    due_date: original.due_date,
                    validity_date: original.validity_date,
                    status: 'PAID',
                    total_payable_before_due: paidTotal,
                    total_payable_after_due: paidTotal,
                    total_arrears: paidArrears,
                } as any,
            });

            const unpaid = await tx.vouchers.create({
                data: {
                    ...commonFields,
                    issue_date: issueDate,
                    due_date: dueDate,
                    validity_date: validityDate,
                    status: 'UNPAID',
                    total_payable_before_due: unpaidTotal,
                    total_payable_after_due: unpaidTotal.add(lateFeeVal),
                    total_arrears: unpaidArrears,
                } as any,
            });

            // ── Step 7: Create voucher_heads.
            //    description_prefix is ALWAYS sourced from student_fees — either directly
            //    (PAID/ISSUED rows) or via splitReplacement (newly split rows).
            await tx.voucher_heads.createMany({
                data: paidHeadRows.map((row) => ({
                    voucher_id: paid.id,
                    student_fee_id: resolveSfId(row.student_fee_id, 'paid'),
                    discount_amount: row.discount_amount,
                    discount_label: row.discount_label,
                    net_amount: row.net_amount,
                    amount_deposited: row.amount_deposited,
                    balance: row.balance,
                    description_prefix: resolvePrefix(row, 'paid'),   // ← always from SF
                } as any)),
            });

            await tx.voucher_heads.createMany({
                data: unpaidHeadRows.map((row) => ({
                    voucher_id: unpaid.id,
                    student_fee_id: resolveSfId(row.student_fee_id, 'unpaid'),
                    discount_amount: row.discount_amount,
                    discount_label: row.discount_label,
                    net_amount: row.net_amount,
                    amount_deposited: row.amount_deposited,
                    balance: row.balance,
                    description_prefix: resolvePrefix(row, 'unpaid'),  // ← always from SF
                } as any)),
            });

            // ── Step 8: Copy surcharge rows from original to the unpaid voucher.
            //    The original's surcharges cascade-delete when the original is voided later,
            //    so we must copy them before that happens.
            const originalSurcharges: any[] = (original as any).voucher_arrear_surcharges ?? [];
            if (originalSurcharges.length > 0) {
                await (tx as any).voucher_arrear_surcharges.createMany({
                    data: originalSurcharges.map((s: any) => ({
                        voucher_id: unpaid.id,
                        arrear_fee_date: s.arrear_fee_date,
                        arrear_month: s.arrear_month,
                        arrear_year: s.arrear_year,
                        amount: s.amount,
                        amount_paid: s.amount_paid || 0,
                        waived: s.waived,
                        waived_by: s.waived_by ?? null,
                    })),
                });
            }

            // ── Step 9: Void the original voucher.
            await tx.vouchers.update({
                where: { id: voucherId },
                data: { status: 'VOID' },
            });

            return { paidVoucher: paid, unpaidVoucher: unpaid };

        }, { timeout: 30000 });

        // ── Generate and upload PDFs (outside transaction to avoid timeout) ────────
        const paidFull = await this.prisma.vouchers.findUnique({ where: { id: paidVoucher.id }, include: VOUCHER_INCLUDE });
        const unpaidFull = await this.prisma.vouchers.findUnique({ where: { id: unpaidVoucher.id }, include: VOUCHER_INCLUDE });

        const [pData, uData] = await Promise.all([
            this.prepareVoucherPdfData(paidFull, true),
            this.prepareVoucherPdfData(unpaidFull, false),
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
        // PAID is also definitional — hardcoded by deposit flow or split transaction.
        // Re-deriving it from student_fees breaks split vouchers where a head only
        // covers a *portion* of the underlying student_fee amount.
        if (voucher.status === 'VOID' || voucher.status === 'PAID') {
            const getAcademicMonthIndex = (m: number) => m >= 8 ? m - 8 : m + 4;
            const mappedHeads = (voucher.voucher_heads || []).map((h: any) => {
                const fee = h.student_fees;
                // Surcharges no longer appear in voucher_heads.
                if (!fee) return { ...h, isArrear: false, isSurcharge: false };

                const feeMonth = fee.month ?? fee.target_month;
                const feeYear = fee.academic_year || '';
                const voucherMonth = voucher.month;
                const voucherYear = voucher.academic_year || '';
                const isSurchargeTotal = false; // surcharges live in voucher_arrear_surcharges now
                let isArrear = false;

                const feeDateStr = fee.fee_date ? new Date(fee.fee_date).toISOString().slice(0, 10) : null;
                const voucherDateStr = voucher.fee_date ? new Date(voucher.fee_date).toISOString().slice(0, 10) : null;
                const sameFeeDate = feeDateStr && voucherDateStr && feeDateStr === voucherDateStr;

                if (!sameFeeDate) {
                    if (isSurchargeTotal) {
                        isArrear = true;
                    } else if (feeYear && voucherYear && feeMonth != null && voucherMonth != null) {
                        if (feeYear < voucherYear) {
                            isArrear = true;
                        } else if (feeYear === voucherYear) {
                            if (getAcademicMonthIndex(feeMonth) < getAcademicMonthIndex(voucherMonth)) {
                                isArrear = true;
                            }
                        }
                    }

                    if (!isArrear && fee.fee_date && voucher.fee_date) {
                        isArrear = new Date(fee.fee_date) < new Date(voucher.fee_date);
                    }
                }

                const isInstallment = !!fee.installment_id;
                const hasInstallmentMerged = !!fee.bundle_id &&
                    (fee.student_fee_bundles?.student_fees?.some((sf: any) => !!sf.installment_id) ?? false);

                return {
                    ...h,
                    isArrear,
                    is_arrear: isArrear,
                    isSurcharge: isSurchargeTotal,
                    is_surcharge: isSurchargeTotal,
                    is_installment: isInstallment,
                    has_installment_merged: hasInstallmentMerged
                };
            });
            return { ...voucher, voucher_heads: mappedHeads };
        }

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

            // Use the head's own amount_deposited, NOT student_fees.amount_paid.
            // student_fees.amount_paid is a GLOBAL counter — it is also non-zero on the
            // balance voucher's heads after a split, which would falsely flag it as
            // PARTIALLY_PAID even though this specific head never received a deposit.
            if (new Prisma.Decimal(h.amount_deposited ?? 0).gt(0)) anyHeadPaidSomewhere = true;
            totalRemHeads = totalRemHeads.add(headRem);

            const feeMonth = fee.month ?? fee.target_month;
            const feeYear = fee.academic_year || '';
            const voucherMonth = voucher.month;
            const voucherYear = voucher.academic_year || '';
            // Surcharges no longer appear in voucher_heads — always false here.
            const isSurchargeTotal = false;
            let isArrear = false;

            const getAcademicMonthIndex = (m: number) => m >= 8 ? m - 8 : m + 4;

            const feeDateStr = fee.fee_date ? new Date(fee.fee_date).toISOString().slice(0, 10) : null;
            const voucherDateStr = voucher.fee_date ? new Date(voucher.fee_date).toISOString().slice(0, 10) : null;
            const sameFeeDate = feeDateStr && voucherDateStr && feeDateStr === voucherDateStr;

            if (!sameFeeDate) {
                if (feeYear && voucherYear && feeMonth != null && voucherMonth != null) {
                    if (feeYear < voucherYear) {
                        isArrear = true;
                    } else if (feeYear === voucherYear) {
                        const feeMonthIdx = getAcademicMonthIndex(feeMonth);
                        const voucherMonthIdx = getAcademicMonthIndex(voucherMonth);
                        if (feeMonthIdx < voucherMonthIdx) {
                            isArrear = true;
                        }
                    }
                }
                if (!isArrear && fee.fee_date && voucher.fee_date) {
                    isArrear = new Date(fee.fee_date) < new Date(voucher.fee_date);
                }
            }

            const isInstallment = !!fee.installment_id;
            const hasInstallmentMerged = !!fee.bundle_id &&
                (fee.student_fee_bundles?.student_fees?.some((sf: any) => !!sf.installment_id) ?? false);

            // Overwrite stored balance with the canonical derived value and attach UI flags
            updatedHeads.push({
                ...h,
                balance: headRem.toString(), // Stringify for reliable JSON serialization
                isArrear,
                is_arrear: isArrear,
                isSurcharge: isSurchargeTotal,
                is_surcharge: isSurchargeTotal,
                is_installment: isInstallment,
                has_installment_merged: hasInstallmentMerged
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

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const dueDate = new Date(voucher.due_date);
        dueDate.setHours(0, 0, 0, 0);
        const isOverdue = today > dueDate;
        const remOverall = isOverdue ? totalRemHeads.add(remLS) : totalRemHeads;

        this.logger.debug(`  Voucher #${voucher.id} Final Calculation: headRemTotal=${totalRemHeads}, remLS=${remLS}, isOverdue=${isOverdue} => remOverall=${remOverall}`);

        const surchargeItems = voucher.voucher_arrear_surcharges || [];
        const activeSurchargeItems = surchargeItems.filter((s: any) => !s.waived);
        const surchargeNetTotal = activeSurchargeItems.reduce(
            (sum: Prisma.Decimal, s: any) => sum.add(new Prisma.Decimal(s.amount || 0)),
            new Prisma.Decimal(0),
        );
        const surchargeDepTotal = activeSurchargeItems.reduce(
            (sum: Prisma.Decimal, s: any) => sum.add(new Prisma.Decimal(s.amount_paid || 0)),
            new Prisma.Decimal(0),
        );
        const surchargeRemTotal = Prisma.Decimal.max(surchargeNetTotal.sub(surchargeDepTotal), new Prisma.Decimal(0));

        // ── Compute status entirely from derived state ──────────────────────────
        let computedStatus: string;

        // Rule: A voucher is PAID if and only if:
        // 1. All main fee heads are fully paid (totalRemHeads <= 0)
        // 2. All arrear surcharges are fully paid (surchargeRemTotal <= 0)
        // 3. Late fee (if applicable) is fully paid (remLS <= 0)
        const allHeadsPaid = totalRemHeads.lte(0);
        const allSurchargesPaid = surchargeRemTotal.lte(0);
        const lateFeePaid = remLS.lte(0);

        const fullyPaid = allHeadsPaid && allSurchargesPaid && (isOverdue ? lateFeePaid : true);
        const anyDep = anyHeadPaidSomewhere || depLS.gt(0) || surchargeDepTotal.gt(0);

        if (fullyPaid) {
            computedStatus = 'PAID';
        } else if (anyDep) {
            computedStatus = 'PARTIALLY_PAID';
        } else if (isOverdue) {
            computedStatus = 'OVERDUE';
        } else {
            computedStatus = 'UNPAID';
        }

        this.logger.debug(`  Voucher #${voucher.id} Result: Computed Status=${computedStatus}`);

        return {
            ...voucher,
            voucher_heads: updatedHeads,
            sf_net_total: sfNetTotal.add(surchargeNetTotal).toFixed(2),
            sf_gross_total: sfGrossTotal.add(surchargeNetTotal).toFixed(2),
            sf_discount_total: sfDiscountTotal.toFixed(2),
            status: computedStatus,
            // Add explicitly for frontend convenience
            surcharge_balance: surchargeRemTotal.toFixed(2),
            head_balance: totalRemHeads.toFixed(2),
            total_balance: (remOverall.add(surchargeRemTotal)).toFixed(2),
            total_deposited: (updatedHeads.reduce((s, h) => s.add(new Prisma.Decimal(h.amount_deposited ?? 0)), new Prisma.Decimal(0)).add(depLS).add(surchargeDepTotal)).toFixed(2),
        };
    }

    // ─── Arrears ─────────────────────────────────────────────────────────────

    /**
     * Compute all unpaid / partially-paid student_fees rows whose fee_date is
     * strictly before targetFeeDate. Returns one virtual surcharge row per distinct
     * arrear month for display. No student_fees rows are written — surcharges are
     * stored in voucher_arrear_surcharges (written by create()).
     */
    async computeArrears(
        studentId: number,
        targetFeeDate: Date,
        waiveSurcharge = false,
        tx?: Prisma.TransactionClient,
    ) {
        const client = tx || this.prisma;

        // 1. Fetch unpaid / partially-paid regular fees before targetFeeDate
        const candidates = await client.student_fees.findMany({
            where: {
                student_id: studentId,
                fee_date: { lt: targetFeeDate },
                status: { notIn: ['PAID', 'DISCOUNT'] as any[] },
                is_arrear_surcharge: false,
                is_discount: false,
            } as any,
            include: { fee_types: true },
            orderBy: { fee_date: 'asc' },
        });

        const rows: any[] = [];
        let totalArrearsCount = new Prisma.Decimal(0);
        const arrearFeeIds: number[] = [];
        const distinctGroups = new Map<string, { date: Date; target_month: number; academic_year: string }>();

        for (const fee of candidates) {
            const amount = new Prisma.Decimal(fee.amount ?? fee.amount_before_discount ?? 0);
            const paid = new Prisma.Decimal(fee.amount_paid ?? 0);
            const outstanding = amount.sub(paid);

            if (outstanding.lte(0)) continue;

            totalArrearsCount = totalArrearsCount.add(outstanding);
            arrearFeeIds.push(fee.id);

            const dateStr = fee.fee_date ? fee.fee_date.toISOString().split('T')[0] : 'undated';
            const groupKey = `${fee.academic_year}_${fee.target_month}`;
            if (fee.academic_year && fee.target_month != null && !distinctGroups.has(groupKey)) {
                distinctGroups.set(groupKey, {
                    date: fee.fee_date!,
                    target_month: fee.target_month,
                    academic_year: fee.academic_year,
                });
            }

            rows.push({
                student_fee_id: fee.id,
                fee_type: (fee as any).fee_types?.description ?? 'Unknown',
                fee_date: dateStr,
                amount: amount.toFixed(2),
                amount_paid: paid.toFixed(2),
                outstanding: outstanding.toFixed(2),
                target_month: fee.target_month,
                academic_year: fee.academic_year,
                isSurcharge: false,
            });
        }

        // 2. One virtual surcharge row per distinct arrear month (display only, no DB write)
        const surchargeGroups = Array.from(distinctGroups.values());
        const totalSurchargeValue = new Prisma.Decimal(surchargeGroups.length * 1000);

        if (!waiveSurcharge) {
            for (const group of surchargeGroups) {
                rows.push({
                    student_fee_id: -1,
                    fee_type: 'Late Payment Surcharge',
                    fee_date: group.date.toISOString().split('T')[0],
                    amount: '1000.00',
                    amount_paid: '0.00',
                    outstanding: '1000.00',
                    target_month: group.target_month,
                    academic_year: group.academic_year,
                    isSurcharge: true,
                });
            }
        }

        return {
            total_arrears: Number(totalArrearsCount.toFixed(2)),
            total_surcharge: Number(totalSurchargeValue.toFixed(2)),
            arrear_fee_ids: arrearFeeIds,
            surcharge_fee_ids: [] as number[], // always empty — surcharges no longer in student_fees
            surcharge_groups: surchargeGroups,
            rows,
        };
    }
    async bulkRemove(ids: number[], force = false) {
        let deleted = 0, skipped = 0;
        const errors: { id: number; reason: string }[] = [];

        for (const id of ids) {
            try {
                force ? await this.forceRemove(id) : await this.remove(id);
                deleted++;
            } catch (e: any) {
                skipped++;
                errors.push({ id, reason: e.message });
            }
        }
        return { deleted, skipped, errors };
    }

    /**
     * Force hard delete a voucher, bypassing status guard.
     * Deletes ANY status including PAID/PARTIALLY_PAID.
     * Resets linked student_fees back to NOT_ISSUED.
     * Deletes deposit_allocations (severs link from underlying deposit).
     */
    async forceRemove(id: number) {
        const voucher = await this.prisma.vouchers.findUnique({
            where: { id },
            include: {
                voucher_heads: {
                    include: { student_fees: true }
                }
            }
        });

        if (!voucher) {
            throw new NotFoundException(`Voucher #${id} not found`);
        }

        // No status guard — allows deleting PAID/PARTIALLY_PAID

        return await this.prisma.$transaction(async (tx) => {
            const heads = voucher.voucher_heads || [];
            const regularFeeIds = heads.map(h => h.student_fee_id);

            // 1. Reset regular student_fees to NOT_ISSUED
            if (regularFeeIds.length > 0) {
                await tx.student_fees.updateMany({
                    where: { id: { in: regularFeeIds } },
                    data: {
                        status: 'NOT_ISSUED',
                        issue_date: null,
                        due_date: null,
                        validity_date: null,
                    }
                });
            }

            // 2. Delete deposit_allocations for this voucher
            await tx.deposit_allocations.deleteMany({
                where: { voucher_id: id }
            });

            // 3. Delete voucher_heads
            await tx.voucher_heads.deleteMany({ where: { voucher_id: id } });

            // 4. Delete the voucher — cascades to voucher_arrear_surcharges automatically.
            const deleted = await tx.vouchers.delete({ where: { id } });

            return deleted;
        }, {
            maxWait: 5000,
            timeout: 15000,
        });
    }
    async remove(id: number) {
        const voucher = await this.prisma.vouchers.findUnique({
            where: { id },
            include: {
                voucher_heads: {
                    include: { student_fees: true }
                }
            }
        });

        if (!voucher) {
            throw new NotFoundException(`Voucher #${id} not found`);
        }

        // Allow deleting UNPAID, OVERDUE, or VOID vouchers.
        if (voucher.status !== 'UNPAID' && voucher.status !== 'OVERDUE' && voucher.status !== 'VOID') {
            throw new BadRequestException(`Only UNPAID, OVERDUE, or VOID vouchers can be deleted. This voucher is ${voucher.status}.`);
        }

        return await this.prisma.$transaction(async (tx) => {
            const heads = voucher.voucher_heads || [];
            const regularFeeIds = heads.map(h => h.student_fee_id);

            // 1. Reset regular student_fees to NOT_ISSUED
            if (regularFeeIds.length > 0) {
                await tx.student_fees.updateMany({
                    where: { id: { in: regularFeeIds } },
                    data: {
                        status: 'NOT_ISSUED',
                        issue_date: null,
                        due_date: null,
                        validity_date: null,
                    }
                });
            }

            // 2. Delete deposit_allocations for this voucher
            await tx.deposit_allocations.deleteMany({
                where: { voucher_id: id }
            });

            // 3. Delete voucher_heads and voucher_arrear_surcharges.
            //    voucher_arrear_surcharges cascade-deletes with the voucher, but we delete
            //    voucher_heads explicitly because of the FK from student_fees.
            await tx.voucher_heads.deleteMany({ where: { voucher_id: id } });

            // 4. Delete the voucher — cascades to voucher_arrear_surcharges automatically.
            const deleted = await tx.vouchers.delete({ where: { id } });

            return deleted;
        }, {
            maxWait: 5000,
            timeout: 15000,
        });
    }

    async batchPreview(dto: BatchPreviewDto) {
        const feeDates = getMonthlyFeeDates(dto.fee_date_from, dto.fee_date_to);

        const { studentRecords, matchingFees, existingVouchers } = await this.bulkLogic.fetchBaseData({
            campus_ids: dto.campus_ids,
            class_ids: dto.class_ids,
            section_ids: dto.section_ids,
            fee_date_from: dto.fee_date_from,
            fee_date_to: dto.fee_date_to,
            include_statuses: dto.include_statuses,
        });

        const { workItems, skips } = this.bulkLogic.resolveWorkItems({
            studentRecords,
            matchingFees,
            existingVouchers,
            fee_date_from: dto.fee_date_from,
            fee_date_to: dto.fee_date_to,
            expectedFeeDates: feeDates,
            skipAlreadyIssued: true, // Don't show already issued students
            academic_year_override: dto.academic_year,
        });

        // Group by student for response
        const studentsMap = new Map<number, any>();

        for (const student of studentRecords) {
            studentsMap.set(student.cc, {
                cc: student.cc,
                full_name: student.full_name,
                class: student.classes?.description || 'N/A',
                section: student.sections?.description || 'N/A',
                voucher_groups: [],
            });
        }

        // Add work items (successful groups)
        for (const item of workItems) {
            const studentEntry = studentsMap.get(item.cc);
            if (studentEntry) {
                studentEntry.voucher_groups.push({
                    fee_date: item.dateStr,
                    academic_year: item.academicYear,
                    heads: item.fees.map((f: any) => ({
                        id: f.id,
                        fee_type: f.fee_types?.description || 'Fee',
                        target_month: f.target_month || f.month,
                        amount: Number(f.amount),
                        status: f.status,
                    })),
                    already_issued: item.alreadyIssued,
                    skip_reason: item.alreadyIssued ? 'ALREADY_ISSUED' : undefined,
                });
            }
        }

        // Add skips
        for (const skip of skips) {
            const studentEntry = studentsMap.get(skip.cc);
            if (studentEntry) {
                studentEntry.voucher_groups.push({
                    fee_date: skip.dateStr,
                    heads: [],
                    already_issued: skip.reason.includes('already issued'),
                    skip_reason: skip.reason,
                });
            }
        }

        // Sort voucher groups by date
        for (const student of studentsMap.values()) {
            student.voucher_groups.sort((a: any, b: any) => a.fee_date.localeCompare(b.fee_date));
        }

        return Array.from(studentsMap.values());
    }
}
