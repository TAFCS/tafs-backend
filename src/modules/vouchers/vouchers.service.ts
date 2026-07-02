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
import { getMonthYearLabel, getConsolidatedMonthsLabel, isSpecial, deriveAcademicYear } from '../../common/utils/academic-labels';
import { toMeezanVoucherNumber } from '../../utils/meezan.util';
import { buildVoucherFilename } from '../../utils/voucher-filename.util';
import { BulkVoucherLogicService } from './bulk-voucher-logic.service';
import { BatchPreviewDto } from './dto/batch-preview.dto';
import { getMonthlyFeeDates } from '../bulk-voucher-jobs/utils/bulk-date.utils';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { VoucherNotificationService } from './voucher-notification.service';
import archiver from 'archiver';
import { PDFDocument } from 'pdf-lib';

const SPLIT_PREFIX_MAX_DB_LEN = 255;
const SF_PREFIX_MAX = 50;

// Set to false before going to production.
const DEV_ALLOW_VOID_DEPOSITS = false;



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
    deposit_allocations: {
        include: {
            deposits: {
                select: {
                    id: true,
                    deposit_date: true,
                    payment_method: true,
                    reference_number: true,
                },
            },
        },
        orderBy: [{ id: 'asc' as const }],
    },
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
        private readonly auditLogs: AuditLogsService,
        private readonly voucherNotificationService: VoucherNotificationService,
    ) { }

    // True for student_fees rows produced by splitPartiallyPaid() — these are a
    // re-allocation of an already-issued fee by amount (PARTIAL/BALANCE PAYMENT OF …),
    // not a fresh discount grant, so they must never show a discount on the voucher.
    private isSplitPaymentPrefix(prefix: string | null | undefined): boolean {
        const p = (prefix ?? '').trim().toUpperCase();
        return p.startsWith('PARTIAL PAYMENT OF') || p.startsWith('BALANCE PAYMENT OF');
    }

    async create(dto: CreateVoucherDto, pdfBuffer?: Buffer, changedBy: string = 'system') {
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
            let bankAccountId = dto.bank_account_id;
            if (!bankAccountId) {
                const defaultBank = await tx.bank_accounts.findFirst({
                    where: { is_default: true },
                });
                if (defaultBank) {
                    bankAccountId = defaultBank.id;
                } else {
                    const firstBank = await tx.bank_accounts.findFirst();
                    if (!firstBank) {
                        throw new BadRequestException('No bank account found in the system to issue the voucher.');
                    }
                    bankAccountId = firstBank.id;
                }
            }

            const newVoucher = await tx.vouchers.create({
                data: {
                    student_id: dto.student_id,
                    campus_id: dto.campus_id,
                    class_id: dto.class_id,
                    section_id: dto.section_id,
                    bank_account_id: bankAccountId!,
                    issue_date: issueDate,
                    due_date: dueDate,
                    validity_date: validityDate,
                    late_fee_charge: dto.late_fee_charge,
                    reprint_fee_charge: dto.reprint_fee_charge ?? false,
                    academic_year: (isSpecial(dto.class_id) && feeDate)
                        ? deriveAcademicYear(feeDate.toISOString(), dto.class_id ?? undefined)
                        : dto.academic_year,
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
                // Exception: PARTIAL/BALANCE PAYMENT OF rows are a re-allocation of an
                // already-issued fee by amount, not a fresh discount grant — they must
                // never show a discount on the voucher.
                const isSplitPaymentRow = this.isSplitPaymentPrefix((fee as any).description_prefix);
                const gross = fee.amount_before_discount ?? fee.amount ?? new Prisma.Decimal(0);
                const discount = isSplitPaymentRow
                    ? new Prisma.Decimal(0)
                    : new Prisma.Decimal(gross).sub(amount);

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
                    discount_label: isSplitPaymentRow ? null : (discountInfo?.discount_label ?? null),
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
            // IMPORTANT: never demote a fee that is already PARTIALLY_PAID or PAID back to ISSUED.
            // The valid forward-only status chain is: NOT_ISSUED → ISSUED → PARTIALLY_PAID / PAID.
            // Arrear fees included in a new voucher must keep their payment progress.
            await Promise.all(
                feeRecords
                    .filter((fee) => !(fee as any).is_discount)
                    .map((fee) => {
                        const alreadyProgressed =
                            (fee as any).status === 'PARTIALLY_PAID' ||
                            (fee as any).status === 'PAID';
                        return tx.student_fees.update({
                            where: { id: fee.id },
                            data: {
                                issue_date: issueDate,
                                due_date: dueDate,
                                validity_date: validityDate,
                                precedence_override: (fee as any).fee_types?.priority_order ?? 0,
                                ...(!alreadyProgressed ? { status: 'ISSUED' as any } : {}),
                            },
                        });
                    }),
            );

            // 5. Update voucher with final totals derived from heads
            const lateFeeVal = dto.late_fee_charge ? (dto.late_fee_amount ?? 1000) : 0;
            // Reprint fee is an unconditional admin-added charge (not tied to the due date
            // like late fee), so it is folded into totalBeforeDueWithSurcharge below and
            // therefore flows into BOTH total_payable_before_due and total_payable_after_due.
            const reprintFeeVal = dto.reprint_fee_charge ? (dto.reprint_fee_amount ?? 100) : 0;

            // Active surcharge = 1000 per distinct arrear month, zero if waived
            const activeSurchargeTotal = (!dto.waive_surcharge && surchargeGroups.length > 0)
                ? new Prisma.Decimal(surchargeGroups.length * 1000)
                : new Prisma.Decimal(0);

            const totalBeforeDueWithSurcharge = totalBeforeDueDecimal.add(activeSurchargeTotal).add(reprintFeeVal);
            const totalAfterDueDecimal = totalBeforeDueWithSurcharge.add(lateFeeVal);

            const updatedVoucher = await tx.vouchers.update({
                where: { id: newVoucher.id },
                data: {
                    total_payable_before_due: totalBeforeDueWithSurcharge,
                    total_payable_after_due: totalAfterDueDecimal,
                    total_arrears: totalArrearsDecimal,
                    voucher_number: toMeezanVoucherNumber(newVoucher.id, feeDate || issueDate),
                    reprint_fee_amount: dto.reprint_fee_charge ? new Prisma.Decimal(reprintFeeVal) : null,
                },
                include: VOUCHER_INCLUDE,
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

            // 6. Void only COMPLETELY superseded vouchers — vouchers whose EVERY fee head
            //    is contained in the new voucher's fee IDs.
            //
            //    Why "every head" and not "any head":
            //    If an October voucher has Aug+Sep as arrears alongside Oct, and a standalone
            //    August voucher is now generated, the October voucher shares SF_AUG but is NOT
            //    superseded — it still covers Sep and Oct. Both must stay active.
            //    A voucher is only superseded when ALL of its heads are absorbed (e.g. an old
            //    Aug-only voucher when a new Aug+Sep+Oct consolidated one is created).
            const feeIdsInNewVoucher = dto.orderedFeeIds ?? [];
            if (feeIdsInNewVoucher.length > 0) {
                const feeIdSet = new Set(feeIdsInNewVoucher);

                // Find candidates — any voucher that shares at least one fee head.
                const overlappingHeads = await tx.voucher_heads.findMany({
                    where: {
                        student_fee_id: { in: feeIdsInNewVoucher },
                        voucher_id: { not: newVoucher.id },
                    },
                    select: { voucher_id: true },
                });
                const candidateIds = Array.from(new Set(overlappingHeads.map(h => h.voucher_id)));

                if (candidateIds.length > 0) {
                    // Fetch every head of every candidate in one query.
                    const allCandidateHeads = await tx.voucher_heads.findMany({
                        where: { voucher_id: { in: candidateIds } },
                        select: { voucher_id: true, student_fee_id: true },
                    });

                    const headsByVoucher = new Map<number, number[]>();
                    for (const h of allCandidateHeads) {
                        if (h.student_fee_id === null) continue;
                        if (!headsByVoucher.has(h.voucher_id)) headsByVoucher.set(h.voucher_id, []);
                        headsByVoucher.get(h.voucher_id)!.push(h.student_fee_id);
                    }

                    const completelySupersededIds: number[] = [];
                    for (const candidateId of candidateIds) {
                        const candidateFeeIds = headsByVoucher.get(candidateId) ?? [];
                        if (candidateFeeIds.length > 0 && candidateFeeIds.every(fid => feeIdSet.has(fid))) {
                            completelySupersededIds.push(candidateId);
                        }
                    }

                    if (completelySupersededIds.length > 0) {
                        await tx.vouchers.updateMany({
                            where: {
                                id: { in: completelySupersededIds },
                                student_id: dto.student_id,
                                status: { notIn: ['PAID', 'VOID'] },
                            },
                            data: { status: 'VOID' },
                        });
                        this.logger.log(
                            `[Voucher ${newVoucher.id}] Voided ${completelySupersededIds.length} completely superseded voucher(s): [${completelySupersededIds.join(', ')}]`,
                        );
                    }
                }
            }

            return updatedVoucher;
        }, { timeout: 15000 });

        let finalVoucher = voucher;

        // 6. Upload PDF if provided (Outside transaction to avoid timeout)
        if (pdfBuffer) {
            try {
                const feeDateStrCreate = feeDate
                    ? feeDate.toISOString().slice(0, 10)
                    : new Date().toISOString().slice(0, 10);
                const studentRec = await this.prisma.students.findUnique({
                    where: { cc: dto.student_id },
                    select: { gr_number: true },
                });
                const grOrCcCreate = studentRec?.gr_number || `CC${dto.student_id}`;
                const key = `vouchers/${dto.student_id}/${buildVoucherFilename({ grNumber: grOrCcCreate, feeDate: feeDateStrCreate, voucherId: voucher.id })}`;
                const pdfUrl = await this.storage.upload(key, pdfBuffer);

                const updatedVoucher = await this.prisma.vouchers.update({
                    where: { id: voucher.id },
                    data: { pdf_url: pdfUrl },
                    include: VOUCHER_INCLUDE,
                });

                finalVoucher = updatedVoucher;
            } catch (error) {
                this.logger.error(`Failed to upload PDF for voucher ${voucher.id}: ${(error as Error).message}`);
                // Use the committed voucher anyway
            }
        }

        const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        const monthLabel = finalVoucher.month ? months[finalVoucher.month - 1] : null;
        const amountStr = finalVoucher.total_payable_before_due ? `Rs. ${Number(finalVoucher.total_payable_before_due).toLocaleString()}` : 'N/A';
        const issueDateStr = finalVoucher.issue_date ? new Date(finalVoucher.issue_date).toLocaleDateString('en-PK', { day: 'numeric', month: 'short', year: 'numeric' }) : 'N/A';
        
        const logNote = [
            `Voucher #${finalVoucher.id} (no. ${finalVoucher.voucher_number || 'N/A'}) created.`,
            `Amount: ${amountStr}`,
            `Issue Date: ${issueDateStr}`,
            monthLabel ? `Month: ${monthLabel}` : null,
            finalVoucher.academic_year ? `AY: ${finalVoucher.academic_year}` : null,
        ].filter(Boolean).join(' | ');

        await this.auditLogs.log({
            entity_type: 'VOUCHER',
            entity_id: String(finalVoucher.id),
            action: 'CREATED',
            changed_by: changedBy,
            student_id: dto.student_id,
            note: logNote,
        });

        this.voucherNotificationService
            .sendVoucherIssuedNotification(finalVoucher.id)
            .catch((err) =>
                this.logger.error(
                    `[Voucher ${finalVoucher.id}] Issued notification failed: ${(err as Error).message}`,
                ),
            );

        return finalVoucher;
    }


    async findAll(
        studentId?: number,
        campusId?: string,
        status?: string,
        classId?: string,
        sectionId?: string,
        cc?: number,
        gr?: string,
        id?: number,
        dateFrom?: string,
        dateTo?: string,
        page: number = 1,
        limit: number = 50,
        singleFeeDate?: boolean,
        multipleFeeHeads?: boolean,
    ) {
        try {
            const skip = (page - 1) * limit;
            const take = limit;

            let validIds: number[] | undefined;

            if (singleFeeDate || multipleFeeHeads) {
                let ids1: number[] | undefined;
                let ids2: number[] | undefined;

                if (singleFeeDate) {
                    const rows = await this.prisma.$queryRaw<{ voucher_id: number }[]>`
                        SELECT vh.voucher_id
                        FROM public.voucher_heads vh
                        JOIN public.student_fees sf ON vh.student_fee_id = sf.id
                        WHERE sf.fee_date IS NOT NULL
                        GROUP BY vh.voucher_id
                        HAVING COUNT(DISTINCT sf.fee_date) = 1
                    `;
                    ids1 = rows.map(r => Number(r.voucher_id));
                }

                if (multipleFeeHeads) {
                    // Opposite of singleFeeDate: vouchers whose heads span more
                    // than one distinct fee_date.
                    const rows = await this.prisma.$queryRaw<{ voucher_id: number }[]>`
                        SELECT vh.voucher_id
                        FROM public.voucher_heads vh
                        JOIN public.student_fees sf ON vh.student_fee_id = sf.id
                        WHERE sf.fee_date IS NOT NULL
                        GROUP BY vh.voucher_id
                        HAVING COUNT(DISTINCT sf.fee_date) > 1
                    `;
                    ids2 = rows.map(r => Number(r.voucher_id));
                }

                if (ids1 !== undefined && ids2 !== undefined) {
                    validIds = ids1.filter(id => ids2!.includes(id));
                } else {
                    validIds = ids1 !== undefined ? ids1 : ids2;
                }
            }

            const toIdList = (value?: string): number[] | undefined =>
                value
                    ? value.split(',').map((v) => parseInt(v.trim(), 10)).filter((v) => !isNaN(v))
                    : undefined;

            const campusIds = toIdList(campusId);
            const classIds = toIdList(classId);
            const sectionIds = toIdList(sectionId);

            const where: Prisma.vouchersWhereInput = {
                // student_id or cc both resolve to student_id (cc is the student PK)
                ...(cc ? { student_id: cc } : studentId ? { student_id: studentId } : {}),
                ...(id ? { id } : {}),
                ...(campusIds?.length ? { campus_id: { in: campusIds } } : {}),
                ...(classIds?.length ? { class_id: { in: classIds } } : {}),
                ...(sectionIds?.length ? { section_id: { in: sectionIds } } : {}),
                // If a specific status is requested show only that; otherwise show all.
                ...(status
                    ? {
                        status: status.includes(',')
                            ? { in: status.split(',').map((s) => s.trim()) }
                            : status,
                      }
                    : {}),
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
                ...(validIds !== undefined ? { id: { in: validIds } } : {}),
            };

            // Stats groupBy uses the same where but without the status filter,
            // so the cards always show a full breakdown across all statuses.
            const { status: _omit, ...statsWhere } = where as any;

            // Fetch all IDs matching the filter for custom sorting in JS
            const allMatching = await this.prisma.vouchers.findMany({
                where,
                select: { id: true, status: true, issue_date: true },
            });

            // Default sort: most recent first, regardless of status.
            allMatching.sort((a, b) => {
                const timeA = a.issue_date?.getTime() ?? 0;
                const timeB = b.issue_date?.getTime() ?? 0;
                if (timeA !== timeB) return timeB - timeA; // desc issue_date
                return b.id - a.id; // desc id
            });

            const total = allMatching.length;
            const paginatedIds = allMatching.slice(skip, skip + take).map(v => v.id);

            const [unsortedVouchers, stats] = await Promise.all([
                this.prisma.vouchers.findMany({
                    where: { id: { in: paginatedIds } },
                    include: VOUCHER_INCLUDE,
                }),
                this.prisma.vouchers.groupBy({
                    by: ['status'],
                    where: statsWhere,
                    _count: { _all: true }
                })
            ]);

            // Restore sorted order
            const vouchers = unsortedVouchers.sort((a, b) => paginatedIds.indexOf(a.id) - paginatedIds.indexOf(b.id));

            const statusStats = {
                paid: 0,
                unpaid: 0,
                overdue: 0,
                void: 0,
                expired: 0
            };

            stats.forEach(s => {
                const count = s._count._all;
                if (s.status === 'PAID') statusStats.paid += count;
                else if (s.status === 'VOID') statusStats.void += count;
                else if (s.status === 'EXPIRED') statusStats.expired += count;
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



    /**
     * Is this voucher_head an "arrear" relative to the voucher it's on?
     *
     * Extracted verbatim from prepareVoucherPdfData's per-head loop — pure
     * refactor, no behavior change. Pulled out so the SPECIAL ADMIN WORKFLOW
     * eligibility guard in generateMainColumnReceipt() can ask "is this head
     * old?" against the raw voucher_heads rows without re-running the whole
     * PDF data-prep pipeline (and without duplicating the date-comparison
     * rules, which would risk the guard drifting out of sync with the real
     * rendering logic below).
     */
    private headIsArrear(h: any, voucher: any): boolean {
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

        return isArrear;
    }

    /** Helper to prepare data for VoucherPdfService */
    private async prepareVoucherPdfData(voucher: any, paidStamp = false, forceHeadsAsCurrent = false) {
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

        // Term cutoff: class IDs 15–19 run Apr–Mar (cutoff=4); all others run Aug–Jul (cutoff=8).
        // Installment sequence order is derived from target_month relative to the term start,
        // so APR is slot 0 for Apr-Mar classes and AUG is slot 0 for Aug-Jul classes.
        const termCutoff = isSpecial(voucher.class_id) ? 4 : 8;
        const installmentSlot = (m: number) => m >= termCutoff ? m - termCutoff : m + (12 - termCutoff);

        studentInstallmentFees.sort((a: any, b: any) =>
            installmentSlot(a.target_month ?? 8) - installmentSlot(b.target_month ?? 8)
        );

        // Group by installment_id for sequence lookup
        const installmentGroups = new Map<number, any[]>();
        (studentInstallmentFees as any[]).forEach(f => {
            // 'PARTIAL PAYMENT OF...' rows are the paid half of a voucher split — their
            // sibling 'BALANCE PAYMENT OF...' row keeps the original id/target_month and
            // already occupies that installment's slot. Counting both would duplicate a
            // slot and shift every later installment's sequence number ("X/Y") by one.
            const isSplitPaidFragment = ((f.description_prefix ?? '') as string).startsWith('PARTIAL PAYMENT OF');
            if (f.installment_id && !isSplitPaidFragment) {
                if (!installmentGroups.has(f.installment_id)) installmentGroups.set(f.installment_id, []);
                installmentGroups.get(f.installment_id)!.push(f);
            }
        });

        // Precompute standalone sequence numbers: map from student_fees.id → 1-based position.
        // Only standalone fees (fee_type_id matches the installment plan's fee_type_id) are counted.
        // Sorted by installmentSlot(target_month) so the position reflects the term's month order.
        const standaloneSequenceMap = new Map<number, number>();
        installmentGroups.forEach((group) => {
            const instFeeTypeId = group.find((f: any) => f.student_fee_installments?.fee_type_id)
                ?.student_fee_installments?.fee_type_id;
            if (!instFeeTypeId) return;
            const standalones = group
                .filter((f: any) => f.fee_type_id === instFeeTypeId)
                .sort((a: any, b: any) =>
                    installmentSlot(a.target_month ?? 8) - installmentSlot(b.target_month ?? 8)
                );
            standalones.forEach((f: any, idx: number) => standaloneSequenceMap.set(f.id, idx + 1));
        });

        // 3a. Build class_fee_schedule lookup for gross-amount and discount calculation.
        //     Discount = schedule.amount − student_fees.amount  (schedule is single source of truth).
        //     student_fees.amount_before_discount is intentionally NOT used here.
        const normalizeAY = (ay: string): string => {
            const parts = (ay ?? '').split('-');
            if (parts.length !== 2) return ay ?? '';
            const start = parts[0].trim();
            const endRaw = parts[1].trim();
            const end = endRaw.length === 2 ? `${start.slice(0, 2)}${endRaw}` : endRaw;
            return `${start}-${end}`;
        };

        const regularHeads = (voucher.voucher_heads as any[]).filter(
            (h: any) => !(h.student_fees?.is_discount === true),
        );
        const scheduleYears = [
            ...new Set(
                regularHeads
                    .map((h: any) => normalizeAY(h.student_fees?.academic_year ?? ''))
                    .filter(Boolean),
            ),
        ] as string[];
        const scheduleFeeIds = [
            ...new Set(
                regularHeads
                    .map((h: any) => h.student_fees?.fee_type_id)
                    .filter((id: any) => id != null),
            ),
        ] as number[];

        const rawScheduleRows =
            scheduleFeeIds.length > 0 && scheduleYears.length > 0
                ? await this.prisma.class_fee_schedule.findMany({
                      where: {
                          class_id: voucher.class_id,
                          fee_id: { in: scheduleFeeIds },
                          academic_year: { in: scheduleYears },
                          OR: [{ campus_id: voucher.campus_id }, { campus_id: null }],
                      },
                  })
                : [];

        // Build map: "fee_type_id|academic_year" → gross amount.
        // Campus-specific row wins over null-campus row for the same key.
        const scheduleMap = new Map<string, number>();
        for (const row of rawScheduleRows) {
            const key = `${row.fee_id}|${normalizeAY(row.academic_year)}`;
            if (!scheduleMap.has(key) || row.campus_id != null) {
                scheduleMap.set(key, Number(row.amount));
            }
        }

        // 3. Initial Mapping of Heads
        let heads = voucher.voucher_heads.map((h: any) => {
            // PARTIAL/BALANCE PAYMENT OF rows are a re-allocation of an already-issued
            // fee by amount, not a fresh discount grant — never show a discount/gross
            // schedule amount for them, just the actual net amount on this row.
            const isSplitHead = this.isSplitPaymentPrefix(h.description_prefix ?? h.student_fees?.description_prefix);
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
                    academic_year: sf?.academic_year ||
                        ((isSpecial(voucher.class_id) && sf?.fee_date)
                            ? deriveAcademicYear(new Date(sf.fee_date).toISOString(), voucher.class_id ?? undefined)
                            : null),
                };
            }
            // ── End discount row ────────────────────────────────────────────

            const feeTypeDesc = sf?.fee_types?.description || 'Fee';
            const prefixStr = h.description_prefix ? `${h.description_prefix} ` : '';
            const sfFeeDate = h.student_fees?.fee_date;
            const effectiveAcadYear = sf?.academic_year ||
                ((isSpecial(voucher.class_id) && sfFeeDate)
                    ? deriveAcademicYear(new Date(sfFeeDate).toISOString(), voucher.class_id ?? undefined)
                    : '');
            const monthSuffix = sf?.target_month != null
                ? ` (${getMonthYearLabel(sf.target_month, effectiveAcadYear, voucher.class_id).toUpperCase()})`
                : '';

            let description = prefixStr + feeTypeDesc + monthSuffix;
            let baseDescription = prefixStr + feeTypeDesc;

            // Handle Installment Sequence (e.g. 1/6)
            // STANDALONE vs MERGED Check:
            // Standalone = student_fees.fee_type_id corresponds to the original installment's fee_type_id.
            // Merged = standalone installment was added/attached to a different head (like tuition).
            const isStandaloneInstallment = sf?.installment_id && sf.fee_type_id === sf.student_fee_installments?.fee_type_id;

            if (isStandaloneInstallment) {
                const group = installmentGroups.get(sf.installment_id) || [];
                const total = sf.student_fee_installments?.installment_count || group.length;
                const seqNum = standaloneSequenceMap.get(sf.id);
                if (seqNum != null) {
                    const installmentLabel = `${prefixStr}${feeTypeDesc} INSTALLMENTS (${seqNum}/${total})`;
                    description = `${installmentLabel}${monthSuffix}`;
                    baseDescription = installmentLabel;
                }
            }

            // Surcharges no longer appear in voucher_heads — they live in voucher_arrear_surcharges.
            const isSurcharge = false;
            let isArrear = this.headIsArrear(h, voucher);

            // ── SPECIAL ADMIN WORKFLOW OVERRIDE ─────────────────────────────
            // See VouchersService.generateMainColumnReceipt() for the full
            // explanation. Only ever true when an admin explicitly asked for
            // the "main column" receipt format on a PAID voucher produced by
            // splitPartiallyPaid() that is made up entirely of old (arrear)
            // heads. Forces this head to be treated as a normal current-period
            // line for THIS render only — nothing is written back to
            // student_fees/voucher_heads, and every other caller passes
            // forceHeadsAsCurrent=false (the default), so this branch is a
            // no-op everywhere else. Safe to remove this whole feature by
            // reverting this parameter and this one line; see the removal
            // checklist in generateMainColumnReceipt()'s docblock.
            if (forceHeadsAsCurrent) isArrear = false;

            const finalPaid = Math.max(Number(h.amount_deposited || 0), Number(h.student_fees?.amount_paid || 0));
            const netAmount = Number(h.net_amount);

            return {
                description,
                originalDescription: feeTypeDesc + monthSuffix,
                baseDescription,
                amount: (() => {
                    if (isSplitHead) return Number(h.net_amount);
                    const schedKey = sf?.fee_type_id != null && sf?.academic_year
                        ? `${sf.fee_type_id}|${normalizeAY(sf.academic_year)}`
                        : null;
                    const schedGross = schedKey ? scheduleMap.get(schedKey) : undefined;
                    return schedGross != null ? schedGross : Number(h.net_amount);
                })(),
                discount: (() => {
                    if (isSplitHead) return 0;
                    const schedKey = sf?.fee_type_id != null && sf?.academic_year
                        ? `${sf.fee_type_id}|${normalizeAY(sf.academic_year)}`
                        : null;
                    const schedGross = schedKey ? scheduleMap.get(schedKey) : undefined;
                    if (schedGross == null) return 0;
                    return Math.max(0, schedGross - Number(sf?.amount ?? h.net_amount));
                })(),
                netAmount,
                amountDeposited: finalPaid,
                balance: Math.max(netAmount - finalPaid, 0),
                isArrear,
                isSurcharge,
                feeDate: h.student_fees?.fee_date?.toISOString().split('T')[0],
                target_month: h.student_fees?.target_month,
                academic_year: effectiveAcadYear || h.student_fees?.academic_year,
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
            return start === end ? `(${start})` : `(${start} - ${end})`;
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

        // Standalone installments that are past + unpaid but absent from this voucher's heads
        // (e.g. became due after the voucher was created). Surfaced as additional arrear rows.
        const installmentSortIdx = (m: number) => m >= cutoff ? m - cutoff : m + (12 - cutoff);
        const missedArrearInstallments = (studentInstallmentFees as any[]).filter(f => {
            if (!(f.installment_id && f.fee_type_id === f.student_fee_installments?.fee_type_id)) return false;
            if (f.status === 'PAID') return false;
            if (voucher.voucher_heads.some((vh: any) => vh.student_fee_id === f.id)) return false;
            if (f.fee_date && voucher.fee_date) {
                return new Date(f.fee_date) < new Date(voucher.fee_date);
            }
            // Fallback: month-based comparison when fee_dates are unavailable
            const fYear = f.academic_year, vYear = voucher.academic_year;
            const fMonth = f.target_month, vMonth = voucher.month;
            if (!fYear || !vYear || fMonth == null || vMonth == null) return false;
            return fYear < vYear || (fYear === vYear && installmentSortIdx(fMonth) < installmentSortIdx(vMonth));
        });

        const missedArrearFeeItems = missedArrearInstallments.map((f: any) => {
            const group = installmentGroups.get(f.installment_id!) || [];
            const total = f.student_fee_installments?.installment_count || group.length;
            const seqNum = standaloneSequenceMap.get(f.id) ?? 0;
            const feeType = f.student_fee_installments?.fee_types?.description || 'Fee';
            const monthLbl = getMonthYearLabel(f.target_month, f.academic_year, voucher.class_id).toUpperCase();
            const desc = `${feeType} INSTALLMENTS (${seqNum}/${total}) (${monthLbl})`;
            const amount = Number(f.amount || 0);
            return {
                description: desc,
                originalDescription: desc,
                baseDescription: `${feeType} INSTALLMENTS (${seqNum}/${total})`,
                amount,
                discount: 0,
                netAmount: amount,
                amountDeposited: 0,
                balance: amount,
                isArrear: true,
                isSurcharge: false,
                isDiscount: false,
                feeDate: f.fee_date?.toISOString().split('T')[0],
                target_month: f.target_month,
                academic_year: f.academic_year,
            };
        });

        const feeHeads = [...consolidatedByRanges, ...nonConsolidatable, ...missedArrearFeeItems];

        // Consolidated month-range label for the arrears row, e.g. "ARREARS (AUG 25 – OCT 25)"
        const arrearHeadsForLabel = nonSurcharges.filter(h => h.isArrear && h.target_month != null);
        const arrearsLabel = arrearHeadsForLabel.length > 0
            ? `ARREARS (${getConsolidatedMonthsLabel(
                arrearHeadsForLabel.map(h => ({ month: h.target_month!, academicYear: h.academic_year || '' })),
                voucher.class_id,
            )})`
            : 'TOTAL ARREARS';

        const totalAmount = Number(voucher.total_payable_before_due || 0);

        const paidStudentFees = await this.prisma.student_fees.findMany({
            where: {
                student_id: voucher.student_id,
                is_discount: false,
                amount_paid: { gt: 0 },
            },
            include: {
                fee_types: true,
                student_fee_installments: { include: { fee_types: true } },
                deposit_allocations: { include: { deposits: true }, orderBy: { id: 'desc' }, take: 1 },
            } as any,
            orderBy: [{ fee_date: 'asc' }, { id: 'asc' }],
        });

        const paymentHistoryRows = paidStudentFees
            .filter((sf: any) => {
                const isStandaloneInstallment = sf.installment_id && sf.fee_type_id === sf.student_fee_installments?.fee_type_id;
                return !isStandaloneInstallment;
            })
            .map((sf: any) => {
                const paidAmount = Number(sf.amount_paid ?? 0);
                if (paidAmount <= 0) return null;

                const feeTypeDesc = sf?.fee_types?.description || 'Fee';
                const prefixStr = sf.description_prefix ? `${sf.description_prefix} ` : '';
                const sfEffectiveYear = sf?.academic_year ||
                    ((isSpecial(voucher.class_id) && sf?.fee_date)
                        ? deriveAcademicYear(new Date(sf.fee_date).toISOString(), voucher.class_id ?? undefined)
                        : '');
                const monthSuffix = sf?.target_month != null
                    ? ` ${getMonthYearLabel(sf.target_month, sfEffectiveYear, voucher.class_id).toUpperCase()}`
                    : '';

                const head = `${prefixStr}${feeTypeDesc}${monthSuffix}`;
                const depositDate = (sf as any).deposit_allocations?.[0]?.deposits?.deposit_date;
                const dateObj = depositDate
                    ? new Date(depositDate)
                    : (sf.fee_date ? new Date(sf.fee_date) : null);

                return {
                    dateObj,
                    date: dateObj ? dateObj.toISOString().split('T')[0] : 'N/A',
                    head,
                    amount: paidAmount,
                };
            })
            .filter((row: any) => !!row)
            .sort((a: any, b: any) => {
                const aTime = a.dateObj ? a.dateObj.getTime() : 0;
                const bTime = b.dateObj ? b.dateObj.getTime() : 0;
                return aTime - bTime;
            });

        let paymentRunningTotal = 0;
        const paymentHistory = paymentHistoryRows.map((row: any) => {
            paymentRunningTotal += row.amount;
            return {
                date: row.date,
                head: row.head,
                amount: row.amount.toLocaleString(),
                totalAmount: paymentRunningTotal.toLocaleString(),
            };
        });

        // Main Label: Consolidate ALL heads in the voucher
        const headsForMainLabel = heads.filter(h => h.target_month != null);
        const monthLabel = headsForMainLabel.length > 0
            ? getConsolidatedMonthsLabel(
                headsForMainLabel.map(h => ({ month: h.target_month!, academicYear: h.academic_year || '' })),
                voucher.class_id,
            )
            : (voucher.month ? monthNames[voucher.month - 1] : (voucher.fee_date ? new Date(voucher.fee_date).toLocaleString('default', { month: 'long' }) : 'N/A'));

        const feeDateStr = voucher.fee_date
            ? new Date(voucher.fee_date).toISOString().slice(0, 10)
            : new Date().toISOString().slice(0, 10);
        const grOrCc = voucher.students?.gr_number || `CC${voucher.student_id}`;
        // SPECIAL ADMIN WORKFLOW: distinct suffix when forceHeadsAsCurrent is on,
        // so this alternate receipt never collides with / overwrites the
        // canonical voucher PDF or its pdf_url. See generateMainColumnReceipt().
        const paidSuffix = [paidStamp ? 'paid' : null, forceHeadsAsCurrent ? 'main-receipt' : null]
            .filter(Boolean)
            .join('-');
        const key = `vouchers/${voucher.student_id}/${buildVoucherFilename({ grNumber: grOrCc, feeDate: feeDateStr, voucherId: voucher.id, suffix: paidSuffix || undefined })}`;
        const qrUrl = this.storage.getPublicUrl(key);

        return {
            voucherData: {
                voucherNumber: (voucher as any).voucher_number ?? voucher.id.toString(),
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
                academicYear: (isSpecial(voucher.class_id) && voucher.fee_date)
                    ? deriveAcademicYear(new Date(voucher.fee_date).toISOString(), voucher.class_id ?? undefined)
                    : (voucher.academic_year || 'N/A'),
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
                reprintFeeAmount: voucher.reprint_fee_charge ? Number(voucher.reprint_fee_amount ?? 100) : 0,
                qrUrl,
                paidStamp,
                showDiscount: false, // DEV kill switch — flip to true to re-enable
                surchargeWaived: voucher.surcharge_waived,
                totalSurcharge: surchargeRows.reduce((sum: number, s: any) => sum + Number(s.amount), 0),
                arrearsLabel,
                arrearsHistory: [
                    ...nonSurcharges
                        .filter(fh => fh.isArrear && !fh.isDiscount)
                        .map(fh => ({
                            date: fh.feeDate || 'N/A',
                            head: fh.description,
                            amount: fh.netAmount.toLocaleString(),
                            totalAmount: fh.netAmount.toLocaleString(),
                            target_month: fh.target_month,
                            academic_year: fh.academic_year,
                        })),
                    ...missedArrearInstallments.map((f: any) => {
                        const group = installmentGroups.get(f.installment_id!) || [];
                        const total = f.student_fee_installments?.installment_count || group.length;
                        const seqIdx = group.findIndex((sf: any) => sf.id === f.id);
                        const feeType = f.student_fee_installments?.fee_types?.description || 'Fee';
                        return {
                            date: f.fee_date?.toISOString().split('T')[0] || 'N/A',
                            head: `${feeType} INSTALLMENTS (${seqIdx + 1}/${total})`,
                            amount: Number(f.amount || 0).toLocaleString(),
                            totalAmount: Number(f.amount || 0).toLocaleString(),
                            target_month: f.target_month,
                            academic_year: f.academic_year,
                        };
                    }),
                ].sort((a, b) => {
                    const aIdx = a.target_month != null ? (getMonthAbsoluteIndex(a.target_month, a.academic_year ?? '') ?? 0) : 0;
                    const bIdx = b.target_month != null ? (getMonthAbsoluteIndex(b.target_month, b.academic_year ?? '') ?? 0) : 0;
                    return aIdx - bIdx;
                }),
                installmentsHistory: (studentInstallmentFees as any[])
                    .filter(f => {
                        const isStandalone = f.installment_id && f.fee_type_id === f.student_fee_installments?.fee_type_id;
                        if (!isStandalone) return false;
                        // Split-paid fragments ('PARTIAL PAYMENT OF...') are the other half
                        // of a 'BALANCE PAYMENT OF...' row that already represents this slot
                        // in the history — listing both would show the same installment twice.
                        if (((f.description_prefix ?? '') as string).startsWith('PARTIAL PAYMENT OF')) return false;
                        // Exclude only the installment(s) that are the current voucher month —
                        // those are already shown in the main fee columns.
                        // Past arrear installments and future installments all belong in the plan.
                        return !(f.target_month === voucher.month && f.academic_year === voucher.academic_year);
                    })
                    .sort((a: any, b: any) => {
                        const aDate = a.fee_date ? new Date(a.fee_date).getTime() : 0;
                        const bDate = b.fee_date ? new Date(b.fee_date).getTime() : 0;
                        return aDate - bDate;
                    })
                    .map((f: any) => {
                        const group = installmentGroups.get(f.installment_id!) || [];
                        const total = f.student_fee_installments?.installment_count || group.length;
                        const seqNum = standaloneSequenceMap.get(f.id) ?? 0;
                        const feeType = f.student_fee_installments?.fee_types?.description || 'Fee';
                        const parts = (f.academic_year || '').split('-');
                        const year = f.target_month != null && f.target_month >= cutoff
                            ? parts[0]
                            : (parts[1] || parts[0]);
                        const month = f.target_month
                            ? `${monthNames[f.target_month - 1].slice(0, 3).toUpperCase()} ${year.slice(-2)}`
                            : 'N/A';
                        return {
                            head: `${feeType} INSTALLMENTS (${seqNum}/${total})`,
                            month,
                            amount: Number(f.amount || 0),
                            status: f.status === 'PAID' ? 'PAID' : 'DUE',
                        };
                    }),
                paymentHistory,
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
        const voidFilter = DEV_ALLOW_VOID_DEPOSITS
            ? {}
            : {
                OR: [
                    // Parents must still see EXPIRED vouchers (APP-01). We only suppress VOID
                    // vouchers unless they have deposits attached.
                    { status: { notIn: ['VOID'] } },
                    {
                        status: { in: ['VOID'] },
                        voucher_heads: { some: { amount_deposited: { gt: 0 } } },
                    },
                ],
            };

        const vouchers = await this.prisma.vouchers.findMany({
            where: {
                student_id: cc,
                ...voidFilter,
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

        // Prefer an active voucher (non-VOID, non-EXPIRED). If none exists for the
        // requested month/year, fall back to the latest EXPIRED voucher so the
        // parent can see it and request regeneration (APP-01).
        const baseWhere = {
            student_id: studentCc,
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
        };

        const orderBy = [{ issue_date: 'desc' as const }, { id: 'desc' as const }];

        let voucher = await this.prisma.vouchers.findFirst({
            where: {
                ...baseWhere,
                status: { notIn: ['VOID', 'EXPIRED'] },
            },
            include: VOUCHER_INCLUDE,
            orderBy,
        });

        if (!voucher) {
            voucher = await this.prisma.vouchers.findFirst({
                where: {
                    ...baseWhere,
                    status: { in: ['EXPIRED'] },
                },
                include: VOUCHER_INCLUDE,
                orderBy,
            });
        }

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

    async recordDeposit(voucherId: number, dto: RecordVoucherDepositDto, changedBy: string = 'system') {
        const depositAmount = new Prisma.Decimal(dto.amount);
        const lateFeeAmount = new Prisma.Decimal(dto.late_fee ?? 0);
        const distributionEntries = Object.entries(dto.distributions ?? {})
            .filter(([, v]) => Number(v) > 0);

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

        if (voucher.status === 'VOID' && !DEV_ALLOW_VOID_DEPOSITS) {
            throw new BadRequestException(
                `Voucher #${voucherId} has been voided and superseded by a newer voucher. Record the deposit against the newer voucher instead.`,
            );
        }
        // EXPIRED vouchers are allowed to receive deposits (fill at own risk) —
        // the frontend surfaces a warning but does not block the operation.

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

        let createdDepositId: number | undefined;

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
                    UPDATE public.voucher_heads
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
                createdDepositId = depositRecord.id;

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
                    // Compute per-student-fee increment from parsedDistributions directly
                    // (avoids a groupBy on voucher_heads that can read a stale
                    // amount_deposited before Step A's increments are visible in the
                    // same Prisma transaction, and also prevents cross-voucher
                    // contamination when the same student_fee has heads in multiple vouchers).
                    const feeIncrementMap = new Map<number, Prisma.Decimal>();
                    for (const { headId, amount } of parsedDistributions) {
                        if (amount.eq(0)) continue;
                        const head = txHeadMap.get(headId)!;
                        if (!head.student_fee_id) continue;
                        const curr = feeIncrementMap.get(head.student_fee_id) ?? new Prisma.Decimal(0);
                        feeIncrementMap.set(head.student_fee_id, curr.add(amount));
                    }

                    const studentFees = await tx.student_fees.findMany({
                        where: { id: { in: affectedStudentFeeIds } },
                    });

                    await Promise.all(
                        studentFees.map((fee) => {
                            const increment = feeIncrementMap.get(fee.id) ?? new Prisma.Decimal(0);
                            if (increment.eq(0)) return Promise.resolve();

                            // Add this deposit's increment to whatever was already paid
                            const totalDeposited = new Prisma.Decimal(fee.amount_paid ?? 0).add(increment);
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

        if (createdDepositId) {
            await this.auditLogs.log({
                entity_type: 'DEPOSIT',
                entity_id: String(createdDepositId),
                action: 'CREATED',
                changed_by: changedBy,
                student_id: voucher.student_id,
                note: `Deposit of Rs. ${depositAmount.toFixed(2)} registered (Ref: ${dto.reference_number || 'N/A'}, Method: ${dto.payment_method || 'N/A'}) against Voucher #${voucherId}.`,
            });
        }

        // 3. FINAL FULL FETCH
        return this.findOne(voucherId);
    }

    /**
     * Delete a deposit entirely (all the vouchers/fees/surcharges it touched,
     * not just one). Recomputes — never blindly zeroes — every affected
     * student_fees.amount_paid, voucher_arrear_surcharges.amount_paid, and
     * voucher_heads row from whatever deposit_allocations remain after this
     * deposit is gone, exactly like clearDeposit does for the single-voucher
     * case. This matters because a fee/surcharge/voucher can receive more
     * than one deposit over its life (e.g. two partial payments, or a manual
     * payment followed by a Meezan settlement) — zeroing instead of
     * recomputing would erase a different deposit's legitimate payment.
     */
    async reverseDeposit(depositId: number, changedBy: string = 'system') {
        const deposit = await this.prisma.deposits.findUnique({
            where: { id: depositId },
            include: { deposit_allocations: true },
        });

        if (!deposit) {
            throw new NotFoundException(`Deposit ${depositId} not found`);
        }

        await this.prisma.$transaction(async (tx) => {
            const allocations = deposit.deposit_allocations;

            const studentFeeIds = [...new Set(
                allocations.filter(a => a.student_fee_id).map(a => a.student_fee_id!)
            )];
            const surchargeIds = [...new Set(
                allocations.filter(a => a.surcharge_id).map(a => a.surcharge_id!)
            )];
            const voucherIds = [...new Set(
                allocations.filter(a => a.voucher_id).map(a => a.voucher_id!)
            )];

            // Delete the deposit first — cascades to its own deposit_allocations,
            // so every "remaining" aggregate below only sees other deposits' rows.
            await tx.deposits.delete({ where: { id: depositId } });

            // Recompute amount_paid for every affected student_fee from what's left.
            for (const sfId of studentFeeIds) {
                const remaining = await tx.deposit_allocations.aggregate({
                    where: { student_fee_id: sfId },
                    _sum: { amount: true },
                });
                const paid = new Prisma.Decimal(remaining._sum.amount ?? 0);
                const fee = await tx.student_fees.findUnique({ where: { id: sfId } });
                if (!fee) continue;
                const canon = new Prisma.Decimal(fee.amount ?? fee.amount_before_discount ?? 0);
                const status = canon.gt(0) && paid.gte(canon) ? 'PAID' : paid.gt(0) ? 'PARTIALLY_PAID' : 'ISSUED';
                await tx.student_fees.update({
                    where: { id: sfId },
                    data: { amount_paid: paid, status: status as any },
                });
            }

            // Recompute amount_paid for every affected surcharge from what's left.
            for (const sId of surchargeIds) {
                const remaining = await tx.deposit_allocations.aggregate({
                    where: { surcharge_id: sId },
                    _sum: { amount: true },
                });
                await tx.voucher_arrear_surcharges.update({
                    where: { id: sId },
                    data: { amount_paid: new Prisma.Decimal(remaining._sum.amount ?? 0) },
                });
            }

            // Recompute each affected voucher's heads, late fee, and status from
            // what's left — the same derivation recordDeposit/clearDeposit use.
            for (const vId of voucherIds) {
                const headTotals = await tx.deposit_allocations.groupBy({
                    by: ['student_fee_id'],
                    where: { voucher_id: vId, student_fee_id: { not: null } },
                    _sum: { amount: true },
                });
                const headMap = new Map(
                    headTotals.map(r => [r.student_fee_id, new Prisma.Decimal(r._sum.amount ?? 0)]),
                );
                const heads = await tx.voucher_heads.findMany({ where: { voucher_id: vId } });
                for (const head of heads) {
                    const deposited = headMap.get(head.student_fee_id) ?? new Prisma.Decimal(0);
                    const balance = Prisma.Decimal.max(
                        new Prisma.Decimal(head.net_amount as any ?? 0).sub(deposited),
                        new Prisma.Decimal(0),
                    );
                    await tx.voucher_heads.update({
                        where: { id: head.id },
                        data: { amount_deposited: deposited, balance },
                    });
                }

                const remLate = await tx.deposit_allocations.aggregate({
                    where: { voucher_id: vId, type: 'LATE_FEE' },
                    _sum: { amount: true },
                });
                const lateFeeDeposited = new Prisma.Decimal(remLate._sum.amount ?? 0);

                const refreshed = await tx.vouchers.findUnique({
                    where: { id: vId },
                    include: { voucher_heads: true },
                });
                if (!refreshed) continue;

                const remainingHeads = refreshed.voucher_heads.reduce(
                    (sum, h) => sum.add(new Prisma.Decimal(h.balance as any ?? 0)),
                    new Prisma.Decimal(0),
                );
                const allMainHeadsPaid = remainingHeads.lte(0);
                const anyHeadDeposited = refreshed.voucher_heads.some((h) =>
                    new Prisma.Decimal(h.amount_deposited as any ?? 0).gt(0),
                );

                const surcharges = await (tx as any).voucher_arrear_surcharges.findMany({
                    where: { voucher_id: vId, waived: false },
                });
                const surchargeRem = surcharges.reduce(
                    (sum: Prisma.Decimal, s: any) =>
                        sum.add(new Prisma.Decimal(s.amount).sub(new Prisma.Decimal(s.amount_paid ?? 0))),
                    new Prisma.Decimal(0),
                );
                const anySurchargeDep = surcharges.some((s: any) =>
                    new Prisma.Decimal(s.amount_paid ?? 0).gt(0),
                );
                const allSurchargesPaid = surchargeRem.lte(0);

                const hasAnyDeposit = anyHeadDeposited || lateFeeDeposited.gt(0) || anySurchargeDep;

                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const dueDate = new Date(refreshed.due_date);
                dueDate.setHours(0, 0, 0, 0);
                const isOverdue = today > dueDate;

                let nextStatus: string;
                if (allMainHeadsPaid && allSurchargesPaid) {
                    nextStatus = 'PAID';
                } else if (hasAnyDeposit) {
                    nextStatus = 'PARTIALLY_PAID';
                } else if (isOverdue) {
                    nextStatus = 'OVERDUE';
                } else {
                    nextStatus = 'UNPAID';
                }

                await tx.vouchers.update({
                    where: { id: vId },
                    data: { status: nextStatus, late_fee_deposited: lateFeeDeposited } as any,
                });
            }
        }, { timeout: 15000 });

        await this.auditLogs.log({
            entity_type: 'DEPOSIT',
            entity_id: String(depositId),
            action: 'DELETED',
            changed_by: changedBy,
            student_id: deposit.student_id,
            note: `Deposit of Rs. ${new Prisma.Decimal(deposit.total_amount).toFixed(2)} reversed/deleted (Ref: ${deposit.reference_number || 'N/A'}).`,
        });

        return { reversed: true, deposit_id: depositId };
    }

    async clearDeposit(voucherId: number, depositId: number, changedBy: string = 'system') {
        // Fetch with full include so the PAID path can run the deletion logic.
        const voucher = await this.prisma.vouchers.findUnique({
            where: { id: voucherId },
            include: { voucher_heads: { include: { student_fees: true } } },
        });

        if (!voucher) {
            throw new NotFoundException(`Voucher with ID ${voucherId} not found`);
        }

        const deposit = await this.prisma.deposits.findUnique({
            where: { id: depositId },
        });

        const isPaidVoucher = voucher.status === 'PAID';

        // Is this voucher a product of splitPartiallyPaid? Future splits carry the
        // split_parent_id marker; legacy splits (pre-marker) are detected via the
        // PARTIAL/BALANCE PAYMENT OF description_prefix left on their heads.
        const isSplitVoucher =
            (voucher as any).split_parent_id != null ||
            voucher.voucher_heads.some((h) => {
                const p = (h.student_fees?.description_prefix ?? '') as string;
                return p.startsWith('PARTIAL PAYMENT OF') || p.startsWith('BALANCE PAYMENT OF');
            });

        let fullUndoHandled = false;

        await this.prisma.$transaction(async (tx) => {
            // ── Step 0: Full split-undo. If this voucher is a marked split child and the
            //    situation is the clean single-level / single-deposit case, reverse the split
            //    entirely — reactivate the original (VOID) voucher with its fees ISSUED + unpaid
            //    and delete both split children. Otherwise fall through to the existing flow.
            if ((voucher as any).split_parent_id != null) {
                const handled = await this._reverseSplitFamilyInTx(voucher as any, depositId, tx);
                if (handled) {
                    fullUndoHandled = true;
                    return;
                }
            }

            // ── Step 1: Capture affected fee IDs, then delete the allocations.
            const allocations = await tx.deposit_allocations.findMany({
                where: { deposit_id: depositId, voucher_id: voucherId },
            });
            const affectedFeeIds = [...new Set(
                allocations.map(a => a.student_fee_id).filter((id): id is number => id != null)
            )];
            const affectedSurchargeIds = [...new Set(
                allocations.map(a => a.surcharge_id).filter((id): id is number => id != null)
            )];

            await tx.deposit_allocations.deleteMany({
                where: { deposit_id: depositId, voucher_id: voucherId },
            });

            // ── Step 2: Delete the deposit record if it is now fully orphaned.
            const remainingOnDeposit = await tx.deposit_allocations.count({
                where: { deposit_id: depositId },
            });
            if (remainingOnDeposit === 0) {
                await tx.deposits.delete({ where: { id: depositId } });
            }

            if (isPaidVoucher && isSplitVoucher) {
                // ── PAID + SPLIT path (UNCHANGED): delete the voucher entirely and reset all
                // heads to NOT_ISSUED. Same logic as remove() — split artifacts are cleaned up,
                // superseded VOID vouchers are reactivated, and the voucher row is hard-deleted.
                await this._destroyVoucherInTx(voucherId, voucher as any, tx, true);
            } else {
                // ── PAID (non-split) / PARTIALLY_PAID / UNPAID path: recalculate from the
                // remaining allocations and re-derive the voucher status (the exact inverse of
                // recordDeposit), preserving all original dates. Removing one of several deposits
                // steps the voucher back PAID → PARTIALLY_PAID → UNPAID/OVERDUE according to what
                // payment still remains; the voucher row and its dates are preserved (NOT deleted).

                // Recalculate student_fees.amount_paid from whatever allocations remain.
                if (affectedFeeIds.length > 0) {
                    const remainingByFee = await tx.deposit_allocations.groupBy({
                        by: ['student_fee_id'],
                        where: { student_fee_id: { in: affectedFeeIds } },
                        _sum: { amount: true },
                    });
                    const remainingMap = new Map(
                        remainingByFee.map(r => [r.student_fee_id, new Prisma.Decimal(r._sum.amount ?? 0)])
                    );

                    const fees = await tx.student_fees.findMany({
                        where: { id: { in: affectedFeeIds } },
                    });

                    for (const fee of fees) {
                        const paid = remainingMap.get(fee.id) ?? new Prisma.Decimal(0);
                        const canon = new Prisma.Decimal(fee.amount ?? 0);
                        const status = paid.gte(canon) ? 'PAID' : paid.gt(0) ? 'PARTIALLY_PAID' : 'ISSUED';
                        await tx.student_fees.update({
                            where: { id: fee.id },
                            data: { amount_paid: paid, status: status as any },
                        });
                    }
                }

                // Recalculate voucher_heads from remaining allocations for this voucher.
                const headTotals = await tx.deposit_allocations.groupBy({
                    by: ['student_fee_id'],
                    where: { voucher_id: voucherId, student_fee_id: { not: null } },
                    _sum: { amount: true },
                });
                const headMap = new Map(
                    headTotals.map(r => [r.student_fee_id, new Prisma.Decimal(r._sum.amount ?? 0)])
                );
                const allHeads = await tx.voucher_heads.findMany({
                    where: { voucher_id: voucherId },
                    select: { id: true, student_fee_id: true, net_amount: true },
                });
                for (const head of allHeads) {
                    const deposited = headMap.get(head.student_fee_id) ?? new Prisma.Decimal(0);
                    const balance = Prisma.Decimal.max(
                        new Prisma.Decimal(head.net_amount as any ?? 0).sub(deposited),
                        new Prisma.Decimal(0),
                    );
                    await tx.voucher_heads.update({
                        where: { id: head.id },
                        data: { amount_deposited: deposited, balance },
                    });
                }

                // ── Recompute late_fee_deposited from the LATE_FEE allocations that REMAIN
                //    on this voucher. recordDeposit writes one LATE_FEE allocation per deposit
                //    recording exactly the late fee it filled, and Step 1 already deleted the
                //    reversed deposit's row — so this reverses precisely that deposit's late fee.
                const remLate = await tx.deposit_allocations.aggregate({
                    where: { voucher_id: voucherId, type: 'LATE_FEE' },
                    _sum: { amount: true },
                });
                const lateFeeDeposited = new Prisma.Decimal(remLate._sum.amount ?? 0);

                // ── Reverse arrear-surcharge amount_paid for every surcharge this deposit
                //    touched, recomputed from whatever allocations still remain against it.
                for (const sid of affectedSurchargeIds) {
                    const remSur = await tx.deposit_allocations.aggregate({
                        where: { surcharge_id: sid },
                        _sum: { amount: true },
                    });
                    await tx.voucher_arrear_surcharges.update({
                        where: { id: sid },
                        data: { amount_paid: new Prisma.Decimal(remSur._sum.amount ?? 0) },
                    });
                }

                // ── Derive the voucher status from what payment actually remains — the exact
                //    inverse of recordDeposit's status logic (PAID → PARTIALLY_PAID → UNPAID/
                //    OVERDUE). Re-fetch heads so the freshly-recalculated balances are read back.
                const refreshed = await tx.vouchers.findUnique({
                    where: { id: voucherId },
                    include: { voucher_heads: true },
                });
                if (!refreshed) {
                    throw new NotFoundException(`Voucher with ID ${voucherId} not found`);
                }

                const remainingHeads = refreshed.voucher_heads.reduce(
                    (sum, h) => sum.add(new Prisma.Decimal(h.balance as any ?? 0)),
                    new Prisma.Decimal(0),
                );
                const allMainHeadsPaid = remainingHeads.lte(0);
                const anyHeadDeposited = refreshed.voucher_heads.some((h) =>
                    new Prisma.Decimal(h.amount_deposited as any ?? 0).gt(0),
                );

                const surcharges = await (tx as any).voucher_arrear_surcharges.findMany({
                    where: { voucher_id: voucherId, waived: false },
                });
                const surchargeRem = surcharges.reduce(
                    (sum: Prisma.Decimal, s: any) =>
                        sum.add(new Prisma.Decimal(s.amount).sub(new Prisma.Decimal(s.amount_paid ?? 0))),
                    new Prisma.Decimal(0),
                );
                const anySurchargeDep = surcharges.some((s: any) =>
                    new Prisma.Decimal(s.amount_paid ?? 0).gt(0),
                );

                const hasAnyDeposit = anyHeadDeposited || lateFeeDeposited.gt(0) || anySurchargeDep;
                const allSurchargesPaid = surchargeRem.lte(0);

                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const dueDate = new Date(refreshed.due_date);
                dueDate.setHours(0, 0, 0, 0);
                const isOverdue = today > dueDate;

                let nextStatus: string;
                if (allMainHeadsPaid && allSurchargesPaid) {
                    nextStatus = 'PAID';
                } else if (hasAnyDeposit) {
                    nextStatus = 'PARTIALLY_PAID';
                } else if (isOverdue) {
                    nextStatus = 'OVERDUE';
                } else {
                    nextStatus = 'UNPAID';
                }

                await tx.vouchers.update({
                    where: { id: voucherId },
                    data: { status: nextStatus, late_fee_deposited: lateFeeDeposited } as any,
                });
            }
        }, { timeout: 15000 });

        if (deposit) {
            await this.auditLogs.log({
                entity_type: 'DEPOSIT',
                entity_id: String(depositId),
                action: 'DELETED',
                changed_by: changedBy,
                student_id: voucher.student_id,
                note: `Deposit of Rs. ${new Prisma.Decimal(deposit.total_amount).toFixed(2)} cleared/reversed (Ref: ${deposit.reference_number || 'N/A'}) against Voucher #${voucherId}.`,
            });
        }

        // The PAID + split delete path and the full split-undo both remove this voucher —
        // nothing to fetch back in either case.
        if (fullUndoHandled || (isPaidVoucher && isSplitVoucher)) return null;

        return this.findOne(voucherId);
    }

    /**
     * Full split-undo for the clean, common case: a deposit recorded BEFORE a
     * splitPartiallyPaid is being reversed. Reconstructs the original (now VOID)
     * voucher — recreating its heads, restoring its fees to ISSUED + unpaid, and
     * merging any partial-split fee rows back — then deletes both split children.
     *
     * Returns true if it handled the reversal; false if the situation is NOT the
     * clean single-level / single-deposit case, in which case the caller falls
     * back to the existing per-voucher reversal flow (delete + NOT_ISSUED).
     *
     * Deliberately self-contained: it does NOT modify _destroyVoucherInTx or the
     * protected splitPartiallyPaid internals. The tight guard below means anything
     * remotely complex (multi-level splits, children with independent deposits,
     * re-split children) bails safely to the proven existing behavior.
     */
    private async _reverseSplitFamilyInTx(child: any, depositId: number, tx: any): Promise<boolean> {
        const parentId = child.split_parent_id;
        if (parentId == null) return false;

        // The original voucher must still exist and be VOID (the split's end state).
        const parent = await tx.vouchers.findUnique({
            where: { id: parentId },
            include: { voucher_arrear_surcharges: true },
        });
        if (!parent || parent.status !== 'VOID') return false;

        // Exactly the two direct split children, neither itself re-split or VOID,
        // in the normal post-split shape (one PAID + one UNPAID/OVERDUE).
        const children = await tx.vouchers.findMany({
            where: { split_parent_id: parentId },
            include: { voucher_heads: { include: { student_fees: true } } },
        });
        if (children.length !== 2) return false;
        for (const c of children) {
            if (c.status === 'VOID') return false;
            const grandchildren = await tx.vouchers.count({ where: { split_parent_id: c.id } });
            if (grandchildren > 0) return false;
        }
        const hasPaid = children.some((c: any) => c.status === 'PAID');
        const hasUnpaid = children.some((c: any) => c.status === 'UNPAID' || c.status === 'OVERDUE');
        if (!hasPaid || !hasUnpaid) return false;

        const childIds = children.map((c: any) => c.id);

        // Every deposit_allocation on the children must belong to the deposit being
        // reversed — otherwise an independent payment exists and a clean undo is impossible.
        const childAllocs = await tx.deposit_allocations.findMany({
            where: { voucher_id: { in: childIds } },
        });
        if (childAllocs.some((a: any) => a.deposit_id !== depositId)) return false;

        // ─────────────────────────────────────────────────────────────────────
        // Guard passed — perform the clean full-undo.
        // ─────────────────────────────────────────────────────────────────────
        const allChildHeads = children.flatMap((c: any) => c.voucher_heads);

        // 1. Merge each partial-split PAID fee row back into its BALANCE row, restoring
        //    the original amount and ISSUED status. Single-level only (guarded above).
        const mergedPaidToBalance = new Map<number, number>(); // paidSfId -> balanceSfId
        for (const h of allChildHeads) {
            const sf = h.student_fees;
            if (!sf) continue;
            const prefix = (sf.description_prefix ?? '') as string;
            if (!prefix.startsWith('PARTIAL PAYMENT OF')) continue;
            if (mergedPaidToBalance.has(sf.id)) continue;

            // Prefer the direct split_pair_id pointer (exact, and survives the balance
            // row's fee_date having moved away from sf.fee_date — see
            // use_nearest_future_fee_date in splitPartiallyPaid). Fall back to the
            // legacy fee_date-based match for rows split before this column existed.
            const balanceSf = (sf as any).split_pair_id
                ? await tx.student_fees.findUnique({ where: { id: (sf as any).split_pair_id } })
                : await tx.student_fees.findFirst({
                    where: {
                        student_id: parent.student_id,
                        fee_type_id: sf.fee_type_id,
                        fee_date: sf.fee_date,
                        id: { not: sf.id },
                        description_prefix: { startsWith: 'BALANCE PAYMENT OF' },
                    } as any,
                });
            if (!balanceSf) return false; // unexpected shape — bail (tx rolls back cleanly)

            // Restore balanceSf's prefix correctly for MULTI-LEVEL splits. If OTHER
            // "PARTIAL PAYMENT OF" rows still exist for this fee slot, balanceSf is still
            // the balance row of a higher-level split and must KEEP its "BALANCE PAYMENT OF
            // [base]" prefix. Only when this is the last/only partial being reversed do we
            // restore it to the bare base label (null for normally-named fees). Mirrors the
            // otherPartialCount logic in _destroyVoucherInTx STEP 2. (sf.id is excluded —
            // it's the partial row being merged away in this same pass.)
            const otherPartialCount = await tx.student_fees.count({
                where: {
                    student_id: parent.student_id,
                    fee_type_id: sf.fee_type_id,
                    fee_date: sf.fee_date,
                    id: { not: sf.id },
                    description_prefix: { startsWith: 'PARTIAL PAYMENT OF' },
                } as any,
            });
            const baseLabel = this.stripSplitPrefix(sf.description_prefix);
            const restoredPrefix = otherPartialCount > 0
                ? this.buildSplitPrefixes(baseLabel).prefixBalance
                : (baseLabel || null);
            await tx.student_fees.update({
                where: { id: balanceSf.id },
                data: {
                    status: 'ISSUED',
                    amount: new Prisma.Decimal(balanceSf.amount ?? 0).add(new Prisma.Decimal(sf.amount ?? 0)),
                    amount_before_discount: new Prisma.Decimal(balanceSf.amount_before_discount ?? 0)
                        .add(new Prisma.Decimal(sf.amount_before_discount ?? 0)),
                    amount_paid: new Prisma.Decimal(0),
                    description_prefix: restoredPrefix,
                    // Restore fee_date to the partial (paid) row's fee_date — undoes any
                    // use_nearest_future_fee_date/balance_fee_date shift applied at split time
                    // (see splitPartiallyPaid), so the merged row lands back on its original period.
                    fee_date: sf.fee_date,
                    // issue/due/validity dates are retained from the original row.
                } as any,
            });
            mergedPaidToBalance.set(sf.id, balanceSf.id);

            // The split's creation step re-points ANY other voucher's heads/allocations
            // that referenced the old fee row onto this PARTIAL row (see splitPartiallyPaid,
            // ~line 3038-3048) — e.g. an arrear/surcharge voucher sharing the same fee slot.
            // Reverse that here: re-link anything still pointing at sf.id onto the restored
            // balance row before sf.id is deleted below, otherwise the FK delete fails for
            // any reference outside the two known split children.
            await tx.voucher_heads.updateMany({
                where: { student_fee_id: sf.id },
                data: { student_fee_id: balanceSf.id },
            });
            await tx.deposit_allocations.updateMany({
                where: { student_fee_id: sf.id },
                data: { student_fee_id: balanceSf.id },
            });
        }

        // 2. Restore every other paid fee row to ISSUED + unpaid (keep dates/amounts).
        //    Only PAID / PARTIALLY_PAID rows are touched — ISSUED and DISCOUNT rows are
        //    left exactly as they are.
        const seen = new Set<number>();
        for (const h of allChildHeads) {
            const sf = h.student_fees;
            if (!sf || mergedPaidToBalance.has(sf.id) || seen.has(sf.id)) continue;
            seen.add(sf.id);
            if (sf.status === 'PAID' || sf.status === 'PARTIALLY_PAID') {
                await tx.student_fees.update({
                    where: { id: sf.id },
                    data: { status: 'ISSUED', amount_paid: new Prisma.Decimal(0) } as any,
                });
            }
        }

        // 3. Aggregate the parent's heads: group child heads by their restored fee row,
        //    summing the net (paid-side net + balance-side net = original net).
        const headAgg = new Map<number, { net: Prisma.Decimal; discount: Prisma.Decimal; label: string | null }>();
        for (const h of allChildHeads) {
            if (h.student_fee_id == null) continue;
            const restoredId = mergedPaidToBalance.get(h.student_fee_id) ?? h.student_fee_id;
            const cur = headAgg.get(restoredId) ?? { net: new Prisma.Decimal(0), discount: new Prisma.Decimal(0), label: null };
            cur.net = cur.net.add(new Prisma.Decimal(h.net_amount ?? 0));
            cur.discount = cur.discount.add(new Prisma.Decimal(h.discount_amount ?? 0));
            if (!cur.label && h.discount_label) cur.label = h.discount_label;
            headAgg.set(restoredId, cur);
        }

        // 4. Delete the reversed deposit's child allocations, then the child vouchers
        //    (cascades their heads + surcharge copies), then the merged-away paid fee rows.
        await tx.deposit_allocations.deleteMany({ where: { voucher_id: { in: childIds } } });
        await tx.vouchers.deleteMany({ where: { id: { in: childIds } } });
        if (mergedPaidToBalance.size > 0) {
            await tx.student_fees.deleteMany({ where: { id: { in: [...mergedPaidToBalance.keys()] } } });
        }

        // 5. Recreate the parent's heads from the aggregation (parent had none after the split).
        await tx.voucher_heads.deleteMany({ where: { voucher_id: parent.id } });
        const restoredSfRows = await tx.student_fees.findMany({
            where: { id: { in: [...headAgg.keys()] } },
            select: { id: true, description_prefix: true },
        });
        const sfPrefix = new Map(restoredSfRows.map((r: any) => [r.id, r.description_prefix]));
        await tx.voucher_heads.createMany({
            data: [...headAgg.entries()].map(([sfId, agg]) => ({
                voucher_id: parent.id,
                student_fee_id: sfId,
                discount_amount: agg.discount,
                discount_label: agg.label,
                net_amount: agg.net,
                amount_deposited: new Prisma.Decimal(0),
                balance: agg.net,
                description_prefix: (sfPrefix.get(sfId) ?? null) as any,
            } as any)),
        });

        // 6. Restore the parent's surcharges (undo their payment) and clear the late-fee cache.
        await tx.voucher_arrear_surcharges.updateMany({
            where: { voucher_id: parent.id },
            data: { amount_paid: new Prisma.Decimal(0) },
        });

        // 7. Reactivate the parent voucher (OVERDUE if its due date has passed, else UNPAID).
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const due = new Date(parent.due_date); due.setHours(0, 0, 0, 0);
        await tx.vouchers.update({
            where: { id: parent.id },
            data: { status: due < today ? 'OVERDUE' : 'UNPAID', late_fee_deposited: new Prisma.Decimal(0) } as any,
        });

        // 8. Delete the deposit if it is now fully orphaned.
        const remaining = await tx.deposit_allocations.count({ where: { deposit_id: depositId } });
        if (remaining === 0) {
            await tx.deposits.delete({ where: { id: depositId } });
        }

        this.logger.log(
            `clearDeposit: full split-undo — reactivated voucher #${parent.id}, deleted split children [${childIds.join(', ')}], reversed deposit #${depositId}.`,
        );
        return true;
    }

    /**
     * Generate a voucher PDF server-side, upload it, persist pdf_url, and return the URL.
     * Used by both the single-voucher challan flow and the PAID-stamp download on the vouchers list.
     */
    async generatePdf(voucherId: number, showDiscount = false, paidStamp = false) {
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
     * ───────────────────────────────────────────────────────────────────────
     * SPECIAL ADMIN WORKFLOW — "arrears paid off, shown as a normal receipt".
     *
     * Context: splitPartiallyPaid() is untouched and correct. Its PAID output
     * voucher inherits its fee_date/month/academic_year from the original
     * voucher's current period (see splitPartiallyPaid's `currentPeriodHead`/
     * `feeRef`/`commonFields`), so an old head left alone on it still reads
     * as an "arrear" by the standard rule (headIsArrear / prepareVoucherPdfData)
     * — there's no "current" head left on that voucher to contrast it
     * against. Admins want an on-demand, alternate rendering of exactly that
     * voucher where the old head(s) show as normal main-column lines instead
     * of the consolidated "ARREARS" line + 4th-column history sidebar. The
     * Rs. 1,000 late-payment surcharge already renders unconditionally in the
     * main columns regardless of any head's arrear flag, so it needs no
     * change here.
     *
     * This method changes nothing about the split, deposits, or any other
     * voucher's PDF — it is read-only (no DB writes), regenerable any number
     * of times, and safe to call concurrently (deterministic storage key, see
     * the `-main-receipt` suffix in prepareVoucherPdfData).
     *
     * Eligibility is intentionally narrow so this can never be used to mask a
     * genuine arrears situation: the voucher must be PAID, must be a product
     * of a split (`split_parent_id` set), and every real (non-discount) head
     * on it must already be a genuine arrear by the unmodified rule. Any
     * voucher with a real *current* head is rejected outright.
     *
     * REMOVAL: delete this method, its controller route
     * (`POST :id/generate-main-column-receipt`), the `forceHeadsAsCurrent`
     * parameter + override line and the `paidSuffix` change in
     * prepareVoucherPdfData, and the one frontend button + handler on each
     * voucher list page. `headIsArrear()` can stay as a harmless extracted
     * helper or be re-inlined. Nothing else depends on any of this.
     * ───────────────────────────────────────────────────────────────────────
     */
    async generateMainColumnReceipt(voucherId: number, changedBy: string = 'system') {
        const voucher = await this.prisma.vouchers.findUnique({
            where: { id: voucherId },
            include: VOUCHER_INCLUDE,
        });
        if (!voucher) throw new NotFoundException(`Voucher ${voucherId} not found`);

        if (voucher.status !== 'PAID') {
            throw new BadRequestException('Only a fully PAID voucher can use the main-column receipt format.');
        }
        if ((voucher as any).split_parent_id == null) {
            throw new BadRequestException(
                'This receipt format only applies to a PAID voucher produced by splitting a partially-paid voucher.',
            );
        }

        // Eligibility guard: every real (non-discount) head must already be a
        // genuine arrear by the unmodified rule. Checked directly against the
        // raw voucher_heads already loaded above — never against
        // prepareVoucherPdfData's synthetic missedArrearFeeItems rows (those
        // represent unrelated overdue installment plans and must keep
        // showing as real arrears) — so a voucher with any real *current*
        // head is rejected outright instead of silently hiding it.
        const realHeads = (voucher.voucher_heads as any[]).filter((h) => h.student_fees?.is_discount !== true);
        if (realHeads.length === 0) {
            throw new BadRequestException('This voucher has no fee heads to render.');
        }
        if (!realHeads.every((h) => this.headIsArrear(h, voucher))) {
            throw new BadRequestException(
                'This voucher still has a current-period head — the main-column receipt is only for paid vouchers made up entirely of old (arrear) heads.',
            );
        }

        const { voucherData, key } = await this.prepareVoucherPdfData(voucher, /* paidStamp */ true, /* forceHeadsAsCurrent */ true);
        voucherData.showDiscount = true; // match the existing "PAID PDF" download convention

        const buffer = await this.pdfService.generateVoucherPdf(voucherData);
        const url = await this.storage.upload(key, buffer);

        // Deliberately NOT persisted to vouchers.pdf_url or any other column —
        // this is a stateless, on-demand alternate render of an existing PAID
        // voucher, not a new canonical artifact. Known accepted trade-off: if
        // the underlying deposit is later reversed via clearDeposit (which
        // hard-deletes a PAID split voucher), a previously generated receipt
        // becomes a harmless orphaned object in storage.
        this.logger.log(
            `generateMainColumnReceipt: ${changedBy} generated a main-column receipt for voucher #${voucherId} (key=${key}).`,
        );

        return { pdf_url: url };
    }

    /**
     * Like generatePdf() but returns the raw buffer alongside the URL.
     * Used by bulk-voucher jobs to collect individual buffers for merging.
     */
    async generatePdfBuffer(voucherId: number, paidStamp = false, generatedByName?: string): Promise<{ buffer: Buffer; url: string }> {
        const voucher = await this.prisma.vouchers.findUnique({
            where: { id: voucherId },
            include: VOUCHER_INCLUDE,
        });

        if (!voucher) throw new NotFoundException(`Voucher ${voucherId} not found`);

        const finalPaidStamp = paidStamp || voucher.status === 'PAID';
        const { voucherData, key } = await this.prepareVoucherPdfData(voucher, finalPaidStamp);
        if (generatedByName) (voucherData as any).generatedByName = generatedByName;
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
                            select: { student_id: true, academic_year: true, month: true, fee_date: true, students: { select: { gr_number: true } } }
                        });
                        const filename = buildVoucherFilename({
                            grNumber: voucher?.students?.gr_number,
                            studentId: voucher?.student_id,
                            feeDate: voucher?.fee_date,
                            voucherId: id,
                        });
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

    // ============================================================================
    // !! AI AGENTS / ASSISTANTS: DO NOT MODIFY ANYTHING IN THIS SECTION !!
    //
    // This covers stripSplitPrefix, buildSplitPrefixes, and splitPartiallyPaid
    // below, as well as the STEP 2 merge block inside _destroyVoucherInTx that
    // reverses splits when a split voucher is deleted/reactivated.
    //
    // This voucher-splitting / merge-on-reversal mechanism — including the
    // prefix scheme, the amount-merge arithmetic, and the multi-level
    // description_prefix cascade-restoration logic — has been carefully
    // audited and fixed end-to-end. It is correct and perfected.
    //
    // Any change here — including "small" refactors, renames, or "obvious"
    // simplifications — risks silently reintroducing data-corruption bugs
    // in student fee balances that are extremely hard to detect and undo.
    //
    // Do not touch this code. If a change genuinely seems necessary, stop
    // and flag it to a human for explicit review instead of editing.
    // ============================================================================

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
        changedBy: string = 'system',
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

            } else if (sf.status === 'DISCOUNT' || (sf as any).is_discount === true) {
                // Discount rows reduce what's owed and never receive a deposit — they
                // always travel with the balance/unpaid side, unchanged (student_fee_id
                // stays put; only the owning voucher changes).
                unpaidHeadRows.push({
                    student_fee_id: sf.id,
                    discount_amount: new Prisma.Decimal(h.discount_amount ?? 0),
                    discount_label: h.discount_label,
                    net_amount: new Prisma.Decimal(h.net_amount ?? 0),
                    amount_deposited: new Prisma.Decimal(0),
                    balance: new Prisma.Decimal(h.balance ?? 0),
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

                // ── Resolve the balance head's fee_date. Default is to preserve it exactly
                //    (the only behavior before this option existed). dto.use_nearest_future_fee_date
                //    takes precedence: it looks up the next student_fees row already on this
                //    student's schedule for the same fee_type (e.g. next month's NOT_ISSUED/ISSUED
                //    row) and rolls the balance onto that period instead — typical case: an arrear
                //    deposit where a Rs.1000 late-payment surcharge is settled now and the
                //    remaining balance should travel to the next voucher rather than sit on the
                //    already-overdue original period. dto.balance_fee_date is a manual admin
                //    override used when no future schedule row exists yet or a specific date is wanted.
                let balanceFeeDate = oldFee.fee_date;
                if (dto.use_nearest_future_fee_date && oldFee.fee_date) {
                    const nextScheduled = await tx.student_fees.findFirst({
                        where: {
                            student_id: oldFee.student_id,
                            fee_type_id: oldFee.fee_type_id,
                            fee_date: { gt: oldFee.fee_date },
                        },
                        orderBy: { fee_date: 'asc' },
                        select: { fee_date: true },
                    });
                    if (nextScheduled?.fee_date) balanceFeeDate = nextScheduled.fee_date;
                } else if (dto.balance_fee_date) {
                    balanceFeeDate = new Date(dto.balance_fee_date);
                }

                // ── Update the original row in-place to become the BALANCE (unpaid) row.
                //    The migration that accompanies this change relaxes the unique constraint
                //    so two rows with split prefixes can share the same
                //    (student_id, fee_type_id, fee_date) when fee_date is left unchanged.
                await tx.student_fees.update({
                    where: { id: oldFeeId },
                    data: {
                        status: 'ISSUED',
                        amount_before_discount: unpaidGross,
                        amount: unpaidNet,
                        amount_paid: new Prisma.Decimal(0),
                        description_prefix: prefixBalance,
                        fee_date: balanceFeeDate,
                    },
                });

                // ── Create a NEW row for the PAID side, sharing the same fee_date.
                //    The partial unique constraint excludes PARTIAL/BALANCE-prefixed rows,
                //    so both halves can coexist with identical (student_id, fee_type_id, fee_date).
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
                        fee_date: oldFee.fee_date,
                        amount_paid: totalPaidOnFee,
                        description_prefix: prefixPaid,
                        // Keep this row attached to the original installment plan (if any) —
                        // otherwise the paid portion silently drops out of the plan's head
                        // list/total. installment_amount is deliberately left unset: it
                        // stays on balanceSf as the full snapshot, so aggregates that sum
                        // it (e.g. calculateFeeSuggestions) keep adding up to the original
                        // total instead of double-counting across both halves.
                        installment_id: oldFee.installment_id,
                        // Pointer back to the balance row (oldFeeId, updated in-place above),
                        // so reversal in _destroyVoucherInTx can find it directly even when
                        // balanceFeeDate above has moved it off oldFee.fee_date.
                        split_pair_id: oldFeeId,
                    } as any,
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
                    unpaidId: oldFeeId,   // original row updated in-place as the balance row
                    prefixPaid,
                    prefixBalance,
                });
            }

            // ── Step 1b: Build a uniform lineage map covering EVERY fee head — not just
            //    the PARTIALLY_PAID ones splitReplacement tracks — so the re-link pass
            //    below can be comprehensive. This is what restores the
            //    deposit_allocations.voucher_id invariant that reverseDeposit/clearDeposit
            //    rely on as ground truth (see Step 9).
            const feeLineage = new Map<number, { side: 'paid' | 'unpaid'; newStudentFeeId: number }>();
            for (const row of paidHeadRows) {
                const rep = splitReplacement.get(row.student_fee_id);
                feeLineage.set(row.student_fee_id, { side: 'paid', newStudentFeeId: rep ? rep.paidId : row.student_fee_id });
            }
            for (const row of unpaidHeadRows) {
                const rep = splitReplacement.get(row.student_fee_id);
                feeLineage.set(row.student_fee_id, { side: 'unpaid', newStudentFeeId: rep ? rep.unpaidId : row.student_fee_id });
            }

            // ── Step 2: Delete all heads on the original voucher (they'll be re-created
            //           under the two new vouchers).
            await tx.voucher_heads.deleteMany({ where: { voucher_id: voucherId } });

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

            // ── Derive feeRef from the head whose fee_date matches the voucher's own
            //    fee_date (the "current period" head), not just the lowest-id head — an
            //    arrear head can easily have the lowest id, which would bake the wrong
            //    MMYY into the new voucher numbers via toMeezanVoucherNumber. Mirrors how
            //    _destroyVoucherInTx derives "current period" via MAX(fee_date).
            const currentPeriodHead = allHeads.find((h) => {
                const fd = h.student_fees?.fee_date;
                return fd && original.fee_date && new Date(fd).getTime() === new Date(original.fee_date).getTime();
            });
            const feeRef = currentPeriodHead?.student_fees ?? allHeads[0]?.student_fees;
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
                    split_parent_id: original.id,
                } as any,
            });
            await tx.vouchers.update({
                where: { id: paid.id },
                data: { voucher_number: toMeezanVoucherNumber(paid.id, targetFeeDate ? new Date(targetFeeDate) : new Date(original.issue_date)) } as any,
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
                    split_parent_id: original.id,
                } as any,
            });
            await tx.vouchers.update({
                where: { id: unpaid.id },
                data: { voucher_number: toMeezanVoucherNumber(unpaid.id, targetFeeDate ? new Date(targetFeeDate) : issueDate) } as any,
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

            // ── Step 8: Classify and (re)create arrear surcharge rows on the correct
            //    side, symmetric to the fee-head treatment above. voucher_arrear_surcharges
            //    support partial payment (amount_paid increments independently of `amount`
            //    — see recordDeposit's surcharge_allocations handling), so a forward-copy
            //    -only approach is lossy: it drops waived rows entirely and discards
            //    payment history on consumed/partial ones. Each new row's id is captured
            //    immediately (via .create, not createMany) so surchargeLineage can drive
            //    the re-link pass below.
            const originalSurcharges: any[] = (original as any).voucher_arrear_surcharges ?? [];
            const surchargeLineage = new Map<number, { side: 'paid' | 'unpaid'; newSurchargeId: number }>();

            // Tracks every surcharge row landing on each side so the new vouchers'
            // own surcharge_waived flag can be derived afterwards (Step 8b) instead
            // of defaulting to false regardless of the rows actually on them.
            const sideSurchargeFlags: Record<'paid' | 'unpaid', { waived: boolean; waived_by: string | null }[]> = {
                paid: [],
                unpaid: [],
            };

            // Accumulate the active (non-waived) surcharge `amount` landing on each side
            // so the vouchers' total_payable_before/after_due can be corrected below —
            // total_payable_before_due/after_due were created from fee heads only
            // (paidTotal/unpaidTotal) and would otherwise drop every arrear surcharge.
            // Mirrors the create path, where activeSurchargeTotal is folded into the
            // before-due total. Waived rows are excluded (they are forgiven, not payable).
            const sideSurchargeBeforeDue: Record<'paid' | 'unpaid', Prisma.Decimal> = {
                paid: new Prisma.Decimal(0),
                unpaid: new Prisma.Decimal(0),
            };

            for (const s of originalSurcharges) {
                const amount = new Prisma.Decimal(s.amount || 0);
                const amountPaid = new Prisma.Decimal(s.amount_paid || 0);
                const baseFields = {
                    arrear_fee_date: s.arrear_fee_date,
                    arrear_month: s.arrear_month,
                    arrear_year: s.arrear_year,
                };

                if (s.waived) {
                    // Waived — preserve the audit trail (waived/waived_by) on the unpaid
                    // side; the old code dropped these rows (and their history) entirely.
                    const created = await (tx as any).voucher_arrear_surcharges.create({
                        data: { voucher_id: unpaid.id, ...baseFields, amount, amount_paid: amountPaid, waived: true, waived_by: s.waived_by ?? null },
                    });
                    surchargeLineage.set(s.id, { side: 'unpaid', newSurchargeId: created.id });
                    sideSurchargeFlags.unpaid.push({ waived: true, waived_by: s.waived_by ?? null });

                } else if (amountPaid.lte(0)) {
                    // Untouched — copy forward as-is (today's behavior for this case).
                    const created = await (tx as any).voucher_arrear_surcharges.create({
                        data: { voucher_id: unpaid.id, ...baseFields, amount, amount_paid: new Prisma.Decimal(0), waived: false, waived_by: null },
                    });
                    surchargeLineage.set(s.id, { side: 'unpaid', newSurchargeId: created.id });
                    sideSurchargeFlags.unpaid.push({ waived: false, waived_by: null });
                    sideSurchargeBeforeDue.unpaid = sideSurchargeBeforeDue.unpaid.add(amount);

                } else if (amountPaid.gte(amount)) {
                    // Fully consumed — travels whole, with its payment history, to the paid side.
                    const created = await (tx as any).voucher_arrear_surcharges.create({
                        data: { voucher_id: paid.id, ...baseFields, amount, amount_paid: amountPaid, waived: false, waived_by: null },
                    });
                    surchargeLineage.set(s.id, { side: 'paid', newSurchargeId: created.id });
                    sideSurchargeFlags.paid.push({ waived: false, waived_by: null });
                    sideSurchargeBeforeDue.paid = sideSurchargeBeforeDue.paid.add(amount);

                } else {
                    // Partially consumed — split into a paid portion that carries the
                    // existing payment history forward, plus a fresh balance portion,
                    // mirroring the PARTIALLY_PAID fee-head split above. Every pre-existing
                    // deposit_allocation against this surcharge funded `amount_paid`, so all
                    // of them belong on the paid portion — the balance portion starts clean.
                    const remaining = amount.sub(amountPaid);
                    const paidPortion = await (tx as any).voucher_arrear_surcharges.create({
                        data: { voucher_id: paid.id, ...baseFields, amount: amountPaid, amount_paid: amountPaid, waived: false, waived_by: null },
                    });
                    await (tx as any).voucher_arrear_surcharges.create({
                        data: { voucher_id: unpaid.id, ...baseFields, amount: remaining, amount_paid: new Prisma.Decimal(0), waived: false, waived_by: null },
                    });
                    surchargeLineage.set(s.id, { side: 'paid', newSurchargeId: paidPortion.id });
                    sideSurchargeFlags.paid.push({ waived: false, waived_by: null });
                    sideSurchargeFlags.unpaid.push({ waived: false, waived_by: null });
                    sideSurchargeBeforeDue.paid = sideSurchargeBeforeDue.paid.add(amountPaid);
                    sideSurchargeBeforeDue.unpaid = sideSurchargeBeforeDue.unpaid.add(remaining);
                }
            }

            // ── Step 8b: Set surcharge_waived on each new voucher from the rows it
            //    actually ended up with — not left at the schema default (false)
            //    regardless of outcome. A side is "waived" only if it has at least
            //    one surcharge row and every one of them is waived.
            for (const side of ['paid', 'unpaid'] as const) {
                const flags = sideSurchargeFlags[side];
                if (flags.length === 0) continue;
                const allWaived = flags.every(f => f.waived);
                const waivedBy = allWaived ? (flags.find(f => f.waived_by)?.waived_by ?? null) : null;
                await tx.vouchers.update({
                    where: { id: side === 'paid' ? paid.id : unpaid.id },
                    data: { surcharge_waived: allWaived, surcharge_waived_by: waivedBy } as any,
                });
            }

            // ── Step 8c: Fold the per-side arrear surcharges into the payable totals.
            //    Step 6 created both vouchers with totals derived from fee heads only
            //    (paidTotal/unpaidTotal); the arrear surcharges classified above must be
            //    added so the printed challan shows fees + surcharges (matching the create
            //    path's totalBeforeDueWithSurcharge). Added to BOTH before- and after-due
            //    so their difference stays exactly the late fee (downstream derives the
            //    late fee as total_payable_after_due − total_payable_before_due).
            if (sideSurchargeBeforeDue.paid.gt(0)) {
                await tx.vouchers.update({
                    where: { id: paid.id },
                    data: {
                        total_payable_before_due: paidTotal.add(sideSurchargeBeforeDue.paid),
                        total_payable_after_due: paidTotal.add(sideSurchargeBeforeDue.paid),
                    } as any,
                });
            }
            if (sideSurchargeBeforeDue.unpaid.gt(0)) {
                const unpaidBeforeDue = unpaidTotal.add(sideSurchargeBeforeDue.unpaid);
                await tx.vouchers.update({
                    where: { id: unpaid.id },
                    data: {
                        total_payable_before_due: unpaidBeforeDue,
                        total_payable_after_due: unpaidBeforeDue.add(lateFeeVal),
                    } as any,
                });
            }

            // ── Step 9: Re-link every live deposit_allocations row so its voucher_id
            //    (and, for surcharges, surcharge_id) points at whichever new voucher now
            //    owns the underlying student_fee / surcharge. Both reverseDeposit and
            //    clearDeposit trust deposit_allocations.voucher_id as ground truth — if
            //    this invariant breaks, reversing a deposit after a split corrupts data
            //    (resurrected "ghost" vouchers, or vouchers permanently stuck PAID).
            //    feeLineage/surchargeLineage are comprehensive — built from the very same
            //    arrays used to create the new heads/surcharges — so this single pass
            //    supersedes the old narrow `paidSfIds`-only re-link, which silently missed
            //    every originally-PAID head and EVERY surcharge allocation (surcharges have
            //    student_fee_id=null and can never match a student_fee_id-keyed filter).
            for (const side of ['paid', 'unpaid'] as const) {
                const targetVoucherId = side === 'paid' ? paid.id : unpaid.id;

                const feeIdsForSide = new Set<number>();
                for (const [oldId, lineage] of feeLineage) {
                    if (lineage.side !== side) continue;
                    feeIdsForSide.add(oldId);
                    feeIdsForSide.add(lineage.newStudentFeeId);
                }
                if (feeIdsForSide.size > 0) {
                    await tx.deposit_allocations.updateMany({
                        where: { voucher_id: voucherId, student_fee_id: { in: [...feeIdsForSide] } },
                        data: { voucher_id: targetVoucherId },
                    });
                }

                for (const [oldSurchargeId, lineage] of surchargeLineage) {
                    if (lineage.side !== side) continue;
                    await tx.deposit_allocations.updateMany({
                        where: { voucher_id: voucherId, surcharge_id: oldSurchargeId },
                        data: { voucher_id: targetVoucherId, surcharge_id: lineage.newSurchargeId },
                    });
                }
            }

            // Late-fee allocations (student_fee_id=null, surcharge_id=null, type=LATE_FEE)
            // represent a flat charge already paid against this voucher — not tied to any
            // single head — so they (and the cached late_fee_deposited total) travel with
            // the settled/paid side as a unit.
            const lateFeeDeposited = new Prisma.Decimal((original as any).late_fee_deposited ?? 0);
            if (lateFeeDeposited.gt(0)) {
                await tx.deposit_allocations.updateMany({
                    where: { voucher_id: voucherId, type: 'LATE_FEE' },
                    data: { voucher_id: paid.id },
                });
                await tx.vouchers.update({
                    where: { id: paid.id },
                    data: { late_fee_deposited: lateFeeDeposited } as any,
                });
            }

            // ── Sweep safety net: validate the invariant directly instead of trusting the
            //    bookkeeping above. In steady state this finds nothing. If it finds rows, a
            //    status branch (or surcharge disposition) was added without registering
            //    lineage — log loudly, self-heal what's discoverable, and abort rather than
            //    silently void a voucher that live payment history still depends on. Modeled
            //    on _destroyVoucherInTx's "idempotent — clearDeposit may have already done
            //    this" defense-in-depth philosophy.
            const stragglers = await tx.deposit_allocations.findMany({ where: { voucher_id: voucherId } });
            if (stragglers.length > 0) {
                this.logger.warn(
                    `splitPartiallyPaid: ${stragglers.length} deposit_allocations row(s) still ` +
                    `reference voucher #${voucherId} after re-link (about to be voided) — self-healing.`,
                );
                for (const alloc of stragglers) {
                    if (alloc.student_fee_id != null) {
                        const head = await tx.voucher_heads.findFirst({
                            where: { student_fee_id: alloc.student_fee_id, voucher_id: { in: [paid.id, unpaid.id] } },
                            select: { voucher_id: true },
                        });
                        if (head) {
                            await tx.deposit_allocations.update({ where: { id: alloc.id }, data: { voucher_id: head.voucher_id } });
                            continue;
                        }
                    }
                    // Surcharge allocations can't be discovered post-hoc: splitting always
                    // mints fresh voucher_arrear_surcharges rows, so the old surcharge_id has
                    // no queryable new home outside the surchargeLineage map built above — if
                    // we're here, that map is incomplete and must be fixed, not papered over.
                    throw new BadRequestException(
                        `splitPartiallyPaid: could not resolve deposit_allocation #${alloc.id} ` +
                        `(student_fee_id=${alloc.student_fee_id}, surcharge_id=${alloc.surcharge_id}, type=${alloc.type}) ` +
                        `to either split voucher — aborting to avoid orphaning live payment history.`,
                    );
                }
            }

            // ── Step 10: Void the original voucher.
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

        try {
            const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
            const monthLabel = original.month ? months[original.month - 1] : null;

            const paidAmtStr = paidVoucher.total_payable_before_due ? `Rs. ${Number(paidVoucher.total_payable_before_due).toLocaleString()}` : 'N/A';
            const paidIssueStr = paidVoucher.issue_date ? new Date(paidVoucher.issue_date).toLocaleDateString('en-PK', { day: 'numeric', month: 'short', year: 'numeric' }) : 'N/A';

            const unpaidAmtStr = unpaidVoucher.total_payable_before_due ? `Rs. ${Number(unpaidVoucher.total_payable_before_due).toLocaleString()}` : 'N/A';
            const unpaidIssueStr = unpaidVoucher.issue_date ? new Date(unpaidVoucher.issue_date).toLocaleDateString('en-PK', { day: 'numeric', month: 'short', year: 'numeric' }) : 'N/A';

            const originalAmtStr = original.total_payable_before_due ? `Rs. ${Number(original.total_payable_before_due).toLocaleString()}` : 'N/A';
            const originalIssueStr = original.issue_date ? new Date(original.issue_date).toLocaleDateString('en-PK', { day: 'numeric', month: 'short', year: 'numeric' }) : 'N/A';

            const voidNote = [
                `Voucher #${voucherId} split into PAID #${paidVoucher.id} and UNPAID #${unpaidVoucher.id} and marked VOID.`,
                `Original Amount: ${originalAmtStr}`,
                `Original Issue Date: ${originalIssueStr}`,
                monthLabel ? `Month: ${monthLabel}` : null,
                original.academic_year ? `AY: ${original.academic_year}` : null,
            ].filter(Boolean).join(' | ');

            const paidNote = [
                `Paid Voucher #${paidVoucher.id} created from split of Voucher #${voucherId}.`,
                `Amount: ${paidAmtStr}`,
                `Issue Date: ${paidIssueStr}`,
                monthLabel ? `Month: ${monthLabel}` : null,
                paidVoucher.academic_year ? `AY: ${paidVoucher.academic_year}` : null,
            ].filter(Boolean).join(' | ');

            const unpaidNote = [
                `Balance Voucher #${unpaidVoucher.id} created from split of Voucher #${voucherId}.`,
                `Amount: ${unpaidAmtStr}`,
                `Issue Date: ${unpaidIssueStr}`,
                monthLabel ? `Month: ${monthLabel}` : null,
                unpaidVoucher.academic_year ? `AY: ${unpaidVoucher.academic_year}` : null,
            ].filter(Boolean).join(' | ');

            await Promise.all([
                this.auditLogs.log({
                    entity_type: 'VOUCHER',
                    entity_id: String(voucherId),
                    action: 'UPDATED',
                    field: 'status',
                    old_value: 'PARTIALLY_PAID',
                    new_value: 'VOID',
                    changed_by: changedBy,
                    student_id: original.student_id,
                    note: voidNote,
                }),
                this.auditLogs.log({
                    entity_type: 'VOUCHER',
                    entity_id: String(paidVoucher.id),
                    action: 'CREATED',
                    changed_by: changedBy,
                    student_id: original.student_id,
                    note: paidNote,
                }),
                this.auditLogs.log({
                    entity_type: 'VOUCHER',
                    entity_id: String(unpaidVoucher.id),
                    action: 'CREATED',
                    changed_by: changedBy,
                    student_id: original.student_id,
                    note: unpaidNote,
                }),
            ]);
        } catch (logErr) {
            this.logger.error(`Failed to write audit logs for split voucher: ${(logErr as Error).message}`);
        }

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
        // EXPIRED is set by the validity-date cron and must not be overridden back to OVERDUE.
        // Re-deriving it from student_fees breaks split vouchers where a head only
        // covers a *portion* of the underlying student_fee amount.
        if (voucher.status === 'VOID' || voucher.status === 'PAID' || voucher.status === 'EXPIRED') {
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

            // Discount rows (is_discount=true) have net_amount<0 and balance=0.
            // They reduce total_payable at voucher creation time and must never be
            // counted in totalRemHeads — doing so would add the discount amount as
            // positive debt instead of subtracting it.
            if (fee.is_discount) {
                updatedHeads.push({
                    ...h,
                    balance: '0',
                    isArrear: false,
                    is_arrear: false,
                    isSurcharge: false,
                    is_surcharge: false,
                    is_installment: false,
                    has_installment_merged: false,
                });
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
        // For discount heads net_amount is already negative (stored as -discountAmount),
        // so using it directly gives the correct sign for every row.
        const sfNetTotal = originalHeads.reduce(
            (sum, head) => sum.add(
                head.student_fees?.is_discount
                    ? new Prisma.Decimal(head.net_amount ?? 0)
                    : new Prisma.Decimal(head.student_fees?.amount ?? head.net_amount ?? 0)
            ),
            new Prisma.Decimal(0),
        );
        const sfGrossTotal = originalHeads.reduce(
            (sum, head) => head.student_fees?.is_discount
                ? sum  // discount rows are not part of gross fees
                : sum.add(new Prisma.Decimal(head.student_fees?.amount_before_discount ?? head.student_fees?.amount ?? head.net_amount ?? 0)),
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

            // 1. Reset regular student_fees to NOT_ISSUED (amount_paid included — a
            //    "deleted/reversed" fee must not be left NOT_ISSUED with a stale paid amount).
            if (regularFeeIds.length > 0) {
                await tx.student_fees.updateMany({
                    where: { id: { in: regularFeeIds } },
                    data: {
                        status: 'NOT_ISSUED',
                        amount_paid: new Prisma.Decimal(0),
                        issue_date: null,
                        due_date: null,
                        validity_date: null,
                    } as any
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
    /**
     * Core voucher deletion logic shared by remove() and the PAID path of clearDeposit().
     * Caller is responsible for opening the transaction and for any pre-delete steps
     * (e.g. clearing deposit allocations before calling this).
     *
     * @param reactivate - Whether to reactivate superseded VOID vouchers.
     *   Pass true for UNPAID/OVERDUE/PAID deletions; false for VOID cleanup.
     */
    private async _destroyVoucherInTx(id: number, voucher: any, tx: any, reactivate: boolean): Promise<any> {
        const heads: any[] = voucher.voucher_heads || [];
        const allFeeIds: number[] = heads
            .map((h: any) => h.student_fee_id)
            .filter((fid: any): fid is number => fid !== null);

        // Derive current-period fee_date = max of all head fee_dates.
        const headFeeDates: Date[] = heads
            .map((h: any) => h.student_fees?.fee_date ? new Date(h.student_fees.fee_date) : null)
            .filter((d: any): d is Date => d !== null);
        const derivedFeeDate = headFeeDates.length > 0
            ? headFeeDates.reduce((max, d) => d > max ? d : max).toISOString().split('T')[0]
            : (voucher.fee_date ? new Date(voucher.fee_date).toISOString().split('T')[0] : null);

        const currentHeads: any[] = derivedFeeDate
            ? heads.filter((h: any) => {
                const sfDate = h.student_fees?.fee_date
                    ? new Date(h.student_fees.fee_date).toISOString().split('T')[0]
                    : null;
                return sfDate === null || sfDate === derivedFeeDate;
            })
            : heads;

        // STEP 1: Find superseded VOID vouchers BEFORE modifying any head links.
        //
        // Reactivate only the voucher(s) DIRECTLY superseded by this deletion —
        // completely-absorbed VOID vouchers (every one of their heads is among this
        // voucher's heads) whose head-set is not itself a subset of another such
        // candidate's head-set.
        //
        // Why: in a chain V1 (heads=[Jan]) -> V2 (heads=[Jan,Feb]) -> V3
        // (heads=[Jan,Feb,Mar]), each fully absorbing the previous, deleting V3 must
        // reactivate only V2 — the previously-made voucher chronologically. V1 stays
        // VOID because V2, once reactivated, still carries Jan as an arrear;
        // reactivating V1 too would create a duplicate active voucher for Jan.
        // Independent arrear vouchers whose head-sets don't subset each other (e.g.
        // a standalone Feb voucher and a standalone Apr voucher both absorbed into a
        // new combined voucher) are unaffected and all reactivate, as before.
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        let supersededVouchers: { id: number; due_date: Date }[] = [];
        if (reactivate && allFeeIds.length > 0) {
            const feeIdSet = new Set(allFeeIds);

            const overlappingHeads = await tx.voucher_heads.findMany({
                where: {
                    student_fee_id: { in: allFeeIds },
                    voucher_id: { not: id },
                },
                select: { voucher_id: true },
            });
            const overlappingIds = Array.from(new Set(overlappingHeads.map((h: any) => h.voucher_id)));

            const candidates = overlappingIds.length > 0
                ? await tx.vouchers.findMany({
                    where: { id: { in: overlappingIds }, student_id: voucher.student_id, status: 'VOID' },
                    select: { id: true, due_date: true },
                })
                : [];

            if (candidates.length > 0) {
                const candidateIds = candidates.map((c: any) => c.id);
                const allCandidateHeads = await tx.voucher_heads.findMany({
                    where: { voucher_id: { in: candidateIds } },
                    select: { voucher_id: true, student_fee_id: true },
                });

                const headsByVoucher = new Map<number, Set<number>>();
                for (const h of allCandidateHeads) {
                    if (h.student_fee_id === null) continue;
                    if (!headsByVoucher.has(h.voucher_id)) headsByVoucher.set(h.voucher_id, new Set());
                    headsByVoucher.get(h.voucher_id)!.add(h.student_fee_id);
                }

                // Completely superseded: every head of the candidate is among this voucher's heads.
                const fullyAbsorbed = candidateIds.filter((cid: number) => {
                    const heads = headsByVoucher.get(cid);
                    return !!heads && heads.size > 0 && [...heads].every(fid => feeIdSet.has(fid));
                });

                // Drop any candidate whose head-set is a proper subset of another
                // fully-absorbed candidate's — it's covered transitively through that
                // other voucher, not directly by this deletion.
                const directlySupersededIds = new Set(fullyAbsorbed.filter((cid: number) => {
                    const heads = headsByVoucher.get(cid)!;
                    return !fullyAbsorbed.some((otherId: number) => {
                        if (otherId === cid) return false;
                        const otherHeads = headsByVoucher.get(otherId)!;
                        return heads.size < otherHeads.size && [...heads].every(fid => otherHeads.has(fid));
                    });
                }));

                supersededVouchers = candidates.filter((c: any) => directlySupersededIds.has(c.id));
            }
        }

        // !! AI AGENTS / ASSISTANTS: DO NOT MODIFY STEP 2 BELOW !!
        // This is the merge/reversal counterpart of the split mechanism documented
        // above stripSplitPrefix/buildSplitPrefixes/splitPartiallyPaid — it has been
        // carefully audited and fixed (amount-merge arithmetic, multi-level
        // description_prefix cascade restoration) and is correct and perfected.
        // Do not touch it; flag any perceived issue to a human instead.
        //
        // STEP 2: Split artifact cleanup.
        // When a PARTIALLY_PAID voucher was split, a new paid SF row was created
        // ('PARTIAL PAYMENT OF' prefix) and the original became the balance row
        // ('BALANCE PAYMENT OF'). Other vouchers' heads were re-linked to the paid row.
        // Undo that: re-link them back to the balance row, restore it, delete the paid row.
        const splitPaidHeads: any[] = currentHeads.filter((h: any) =>
            ((h.student_fees?.description_prefix ?? '') as string).startsWith('PARTIAL PAYMENT OF')
        );
        const splitPaidFeeIds: number[] = splitPaidHeads
            .map((h: any) => h.student_fee_id)
            .filter((fid: any): fid is number => fid !== null);

        for (const splitHead of splitPaidHeads) {
            const sfPaid = splitHead.student_fees;
            if (!sfPaid?.fee_type_id || !sfPaid?.fee_date) continue;

            // Prefer the direct split_pair_id pointer (set at split time) — it's exact
            // and survives the balance row's fee_date having been moved away from
            // sfPaid.fee_date (see use_nearest_future_fee_date in splitPartiallyPaid).
            // Fall back to the legacy fee_date-based match for rows split before this
            // column existed (split_pair_id is NULL on them).
            const balanceSf = (sfPaid as any).split_pair_id
                ? await tx.student_fees.findUnique({ where: { id: (sfPaid as any).split_pair_id } })
                : await tx.student_fees.findFirst({
                    where: {
                        student_id: voucher.student_id,
                        fee_type_id: sfPaid.fee_type_id,
                        fee_date: sfPaid.fee_date,
                        id: { not: sfPaid.id },
                        description_prefix: { startsWith: 'BALANCE PAYMENT OF' },
                    } as any,
                });

            if (balanceSf) {
                await tx.voucher_heads.updateMany({
                    where: { student_fee_id: sfPaid.id, voucher_id: { not: id } },
                    data: { student_fee_id: balanceSf.id },
                });

                // The split divided the original amount exactly in two — paidGross/
                // unpaidGross and totalPaidOnFee/unpaidNet each sum back to the
                // pre-split amount_before_discount/amount (see splitPartiallyPaid's
                // Step 1). Re-merging must add sfPaid's half back onto balanceSf's
                // half to restore that original total — leaving balanceSf's figures
                // untouched would silently shrink the head to just its balance
                // portion, with the paid portion's amount lost forever once sfPaid
                // is deleted in STEP 5 below.
                const mergedAmount = new Prisma.Decimal(balanceSf.amount ?? 0)
                    .add(new Prisma.Decimal(sfPaid.amount ?? 0));
                const mergedGross = new Prisma.Decimal(balanceSf.amount_before_discount ?? 0)
                    .add(new Prisma.Decimal(sfPaid.amount_before_discount ?? 0));

                // Determine whether other "PARTIAL PAYMENT OF" rows still exist for
                // this fee slot. If yes, balanceSf is still the balance row for
                // those higher-level splits and must keep its "BALANCE PAYMENT OF"
                // prefix so the next reversal can locate it. If no (this was the
                // last/only split being reversed), restore the prefix to null — the
                // row goes back to its pristine pre-split state. Without this check
                // every multi-level reversal would wipe the prefix on the first
                // reversal, making every subsequent reversal silently skip the
                // merge (balanceSf query returns nothing) and lose the paid amount.
                const otherPartialCount = await tx.student_fees.count({
                    where: {
                        student_id: voucher.student_id,
                        fee_type_id: sfPaid.fee_type_id,
                        fee_date: sfPaid.fee_date,
                        id: { not: sfPaid.id },
                        description_prefix: { startsWith: 'PARTIAL PAYMENT OF' },
                    } as any,
                });
                // Derive the correct balance prefix from sfPaid's own prefix so
                // custom-named heads (e.g. "PARTIAL PAYMENT OF TRANSPORT FEE")
                // are correctly restored to "BALANCE PAYMENT OF TRANSPORT FEE"
                // rather than the bare "BALANCE PAYMENT OF".
                const baseLabel = this.stripSplitPrefix(sfPaid.description_prefix);
                const { prefixBalance: restoredPrefix } = otherPartialCount > 0
                    ? this.buildSplitPrefixes(baseLabel)
                    : { prefixBalance: null };

                await tx.student_fees.update({
                    where: { id: balanceSf.id },
                    data: {
                        status: 'NOT_ISSUED',
                        description_prefix: restoredPrefix,
                        amount: mergedAmount,
                        amount_before_discount: mergedGross,
                        amount_paid: new Prisma.Decimal(0),
                        issue_date: null,
                        due_date: null,
                        validity_date: null,
                        // Restore fee_date to the partial (paid) row's fee_date — undoes any
                        // use_nearest_future_fee_date/balance_fee_date shift applied at split
                        // time (see splitPartiallyPaid), so the merged row lands back on its
                        // original period.
                        fee_date: sfPaid.fee_date,
                    } as any,
                });
            }
        }

        // STEP 3: Delete deposit_allocations (idempotent — clearDeposit may have already done this).
        await tx.deposit_allocations.deleteMany({ where: { voucher_id: id } });

        // STEP 4: Delete this voucher's heads (must precede student_fees deletes due to FK).
        await tx.voucher_heads.deleteMany({ where: { voucher_id: id } });

        // STEP 5: Delete split-created paid SF rows (safe now — no heads or allocs reference them).
        const splitPaidFeeIdsToDelete = splitPaidHeads
            .filter((h: any) => h.student_fees?.fee_type_id != null && h.student_fees?.fee_date != null)
            .map((h: any) => h.student_fee_id)
            .filter((fid: any): fid is number => fid !== null);
        if (splitPaidFeeIdsToDelete.length > 0) {
            await tx.student_fees.deleteMany({ where: { id: { in: splitPaidFeeIdsToDelete } } });
        }

        // STEP 6: Reset regular current-period student_fees → NOT_ISSUED.
        //         amount_paid must be zeroed too — otherwise a "reversed" fee ends up
        //         NOT_ISSUED while still carrying its old paid amount, corrupting the
        //         very ledger this whole deletion/reversal path exists to restore.
        const regularCurrentFeeIds: number[] = currentHeads
            .map((h: any) => h.student_fee_id)
            .filter((fid: any): fid is number => fid !== null)
            .filter((fid: number) => !splitPaidFeeIds.includes(fid));
        if (regularCurrentFeeIds.length > 0) {
            await tx.student_fees.updateMany({
                where: { id: { in: regularCurrentFeeIds } },
                data: {
                    status: 'NOT_ISSUED',
                    amount_paid: new Prisma.Decimal(0),
                    issue_date: null,
                    due_date: null,
                    validity_date: null,
                } as any,
            });
        }

        // STEP 7: Reactivate superseded VOID vouchers (OVERDUE if due_date passed, else UNPAID).
        for (const sv of supersededVouchers) {
            const svDue = new Date(sv.due_date);
            svDue.setHours(0, 0, 0, 0);
            await tx.vouchers.update({
                where: { id: sv.id },
                data: { status: svDue < today ? 'OVERDUE' : 'UNPAID' },
            });
        }

        // STEP 8: Delete the voucher (cascades to voucher_arrear_surcharges automatically).
        return tx.vouchers.delete({ where: { id } });
    }

    async remove(id: number, changedBy: string = 'system') {
        const voucher = await this.prisma.vouchers.findUnique({
            where: { id },
            include: { voucher_heads: { include: { student_fees: true } } },
        });

        if (!voucher) {
            throw new NotFoundException(`Voucher #${id} not found`);
        }

        // PAID and PARTIALLY_PAID vouchers cannot be deleted directly.
        // To undo a payment: clear the deposit via the deposit page — for PAID vouchers the
        // deposit clear automatically deletes the voucher; for PARTIALLY_PAID it reverts to UNPAID.
        if (voucher.status !== 'UNPAID' && voucher.status !== 'OVERDUE' && voucher.status !== 'VOID' && voucher.status !== 'EXPIRED') {
            throw new BadRequestException(
                `Only UNPAID, OVERDUE, VOID, or EXPIRED vouchers can be deleted. ` +
                `Voucher #${id} is ${voucher.status}. Clear its deposits first.`
            );
        }

        const result = await this.prisma.$transaction(
            (tx) => this._destroyVoucherInTx(id, voucher, tx, voucher.status !== 'VOID' && voucher.status !== 'EXPIRED'),
            { maxWait: 5000, timeout: 15000 },
        );

        await this.auditLogs.log({
            entity_type: 'VOUCHER',
            entity_id: String(id),
            action: 'DELETED',
            changed_by: changedBy,
            student_id: voucher.student_id,
            note: `Voucher #${id} (no. ${voucher.voucher_number || 'N/A'}) deleted/voided.`,
        });

        return result;
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
