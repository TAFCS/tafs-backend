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
import { CreateBulkVouchersDto } from './dto/create-bulk-vouchers.dto';
import { PreviewBulkVouchersDto } from './dto/preview-bulk-vouchers.dto';
import { UpdateVoucherDto } from './dto/update-voucher.dto';
import { RecordVoucherDepositDto } from './dto/record-voucher-deposit.dto';
import { SplitPartiallyPaidDto } from './dto/split-partially-paid.dto';
import { StorageService } from '../../common/storage/storage.service';
import { VoucherPdfService } from '../voucher-pdf/voucher-pdf.service';

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
                    student_fee_bundles: true,
                    student_fee_installments: {
                        include: { fee_types: true }
                    }
                }
            }
        }
    }
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
            // 1.a Automatically find and include Arrear Surcharges
            let finalOrderedFeeIds = [...(dto.orderedFeeIds ?? [])];
            let potentialSurchargeAmount = 0;

            if (feeDate) {
                // We ALWAYS compute arrears to get the potential surcharge amount for the waiver note.
                // We pass persist=true to ensure student_fees exist if not waiving.
                const arrearsInfo = await this.computeArrears(dto.student_id, feeDate, dto.waive_surcharge, true, tx);
                potentialSurchargeAmount = arrearsInfo.total_surcharge;

                if (!dto.waive_surcharge && arrearsInfo.surcharge_fee_ids.length > 0) {
                    for (const sId of arrearsInfo.surcharge_fee_ids) {
                        if (!finalOrderedFeeIds.includes(sId)) {
                            finalOrderedFeeIds.push(sId);
                        }
                    }
                }
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
            let totalArrearSurchargesDecimal = new Prisma.Decimal(0);

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

                // Calculate Arrear Totals
                const isSurcharge = (fee as any).is_arrear_surcharge === true;
                const isArrear = !isSurcharge && feeDate && fee.fee_date && new Date(fee.fee_date) < feeDate;

                if (isSurcharge) {
                    totalArrearSurchargesDecimal = totalArrearSurchargesDecimal.add(netAmount);
                } else if (isArrear) {
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

            // 4. Update student_fees records to mark them as ISSUED
            await Promise.all(
                feeRecords.map((fee) =>
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
            const totalAfterDueDecimal = totalBeforeDueDecimal.add(lateFeeVal);

            await tx.vouchers.update({
                where: { id: newVoucher.id },
                data: {
                    total_payable_before_due: totalBeforeDueDecimal,
                    total_payable_after_due: totalAfterDueDecimal,
                    total_arrears: totalArrearsDecimal,
                    total_arrear_surcharge: potentialSurchargeAmount,
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

        const CHUNK_SIZE = 25;
        for (let i = 0; i < selection.eligibleStudents.length; i += CHUNK_SIZE) {
            const chunk = selection.eligibleStudents.slice(i, i + CHUNK_SIZE);

            await Promise.all(chunk.map(async (item) => {
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
                        waive_surcharge: dto.waive_surcharge,
                        waived_by: dto.waived_by,
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
            }));
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

            const [total, vouchers] = await Promise.all([
                this.prisma.vouchers.count({ where }),
                this.prisma.vouchers.findMany({
                    where,
                    include: VOUCHER_INCLUDE,
                    orderBy: [{ issue_date: 'desc' }, { id: 'desc' }],
                    skip,
                    take,
                }),
            ]);

            return {
                items: vouchers.map((v) => this.normalizeVoucher(v)),
                meta: {
                    total,
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
    private async prepareVoucherPdfData(voucher: any, paidStamp?: boolean, descriptionPrefix?: string) {
        // 1. Fetch siblings if family_id exists
        let siblings: any[] = [];
        if (voucher.students?.family_id) {
            siblings = await this.prisma.students.findMany({
                where: { family_id: voucher.students.family_id, deleted_at: null, status: 'ENROLLED' },
                include: { classes: true, sections: true }
            });
        }

        const voucherLevelPrefix = descriptionPrefix;

        // 2. Map heads correctly
        const monthNames = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
        const feeHeads = voucher.voucher_heads.map((h: any) => {
            const feeDescription = h.student_fees?.fee_types?.description || 'Fee';

            // Append month label for tuition fees, e.g. "Monthly Tuition Fee (APR 25)"
            const isTuition = feeDescription.toLowerCase().includes('tuition');
            const isSurcharge = feeDescription.toLowerCase().includes('surcharge');
            const targetMonth: number | null = h.student_fees?.target_month ?? null;
            let monthSuffix = '';

            if (targetMonth) {
                const monthName = monthNames[targetMonth] || '';
                const acYear: string = h.student_fees?.academic_year || voucher.academic_year || '';
                const parts = acYear.split('-');
                const year = targetMonth >= 8 ? parts[0] : (parts[1] || parts[0]);

                if (isSurcharge) {
                    // Surcharge keeps the short format (APR '25)
                    monthSuffix = ` (${monthName.slice(0, 3).toUpperCase()}'${year ? ' ' + year.slice(-2) : ''})`;
                } else {
                    // Tuition keeps the short format (APR '25)
                    monthSuffix = ` (${monthName.slice(0, 3).toUpperCase()}'${year ? ' ' + year.slice(-2) : ''})`;
                }
            }

            const headPrefixRaw = h.description_prefix && String(h.description_prefix).trim();
            const prefixToUse = headPrefixRaw || voucherLevelPrefix || '';
            const finalPrefix = prefixToUse ? `${prefixToUse} — ` : '';

            let description = `${finalPrefix}${feeDescription}${monthSuffix}`;
            const instAmount = (h.student_fees as any)?.installment_amount ? Number((h.student_fees as any).installment_amount) : 0;
            const instFeeType = (h.student_fees as any)?.student_fee_installments?.fee_types?.description;
            
            if (instAmount > 0 && instFeeType && instFeeType !== feeDescription) {
                // If it's an embedded one, add a small notice
                description += ` (Inc. ${instFeeType} Split — PKR ${instAmount.toLocaleString()})`;
            }

            const isSplitHead = !!headPrefixRaw;

            // Arrear Logic: Compare academic month/year with voucher's month/year
            const feeMonth = h.student_fees?.month ?? h.student_fees?.target_month;
            const feeYear = h.student_fees?.academic_year || '';
            const voucherMonth = voucher.month;
            const voucherYear = voucher.academic_year || '';

            const isSurchargeTotal = h.student_fees?.is_arrear_surcharge === true;
            let isArrear = false;
            
            // Helper to convert calendar month to academic sort index (Aug=0...Jul=11)
            const getAcademicMonthIndex = (m: number) => m >= 8 ? m - 8 : m + 4;

            // fee_date is the canonical source of truth for "which period does this fee belong to?"
            // If fee_date matches the voucher's fee_date, this head is NOT an arrear.
            const feeDateStr = h.student_fees?.fee_date ? new Date(h.student_fees.fee_date).toISOString().slice(0, 10) : null;
            const voucherDateStr = voucher.fee_date ? new Date(voucher.fee_date).toISOString().slice(0, 10) : null;
            const sameFeeDate = feeDateStr && voucherDateStr && feeDateStr === voucherDateStr;

            if (!sameFeeDate && !isSurchargeTotal) {
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
                if (!isArrear && h.student_fees?.fee_date && voucher.fee_date) {
                    isArrear = new Date(h.student_fees.fee_date) < new Date(voucher.fee_date);
                }
            }

            const amountPaid = Number(h.amount_deposited || 0);
            const feePaid = Number(h.student_fees?.amount_paid || 0);
            const finalPaid = Math.max(amountPaid, feePaid);
            const netAmount = Number(h.net_amount);
            const balance = Math.max(netAmount - finalPaid, 0);

            return {
                description,
                originalDescription: feeDescription + monthSuffix,
                amount: isSplitHead ? Number(h.net_amount) : Number(h.student_fees?.amount_before_discount || h.net_amount || 0),
                discount: isSplitHead ? 0 : Number(h.discount_amount || 0),
                netAmount,
                amountDeposited: finalPaid,
                balance,
                discountLabel: isSplitHead ? '' : (h.discount_label || ''),
                isArrear,
                isSurcharge: isSurchargeTotal,
                feeDate: h.student_fees?.fee_date?.toISOString().split('T')[0],
                target_month: h.student_fees?.target_month,
                academic_year: h.student_fees?.academic_year,
            };
        });

        const totalPaid = feeHeads.reduce((sum, h) => sum + h.amountDeposited, 0);
        const totalAmount = Number(voucher.total_payable_before_due || 0);
        const outstandingBalance = Math.max(totalAmount - totalPaid, 0);
        const lateFeeAmount = voucher.late_fee_charge ? 1000 : 0;

        // Resolve Month Label
        const monthLabel = voucher.month ? monthNames[voucher.month] : (voucher.fee_date ? new Date(voucher.fee_date).toLocaleString('default', { month: 'long' }) : 'N/A');

        // Prepare Key & QR URL
        const ts = Date.now();
        const filePrefix = paidStamp ? 'paid-voucher' : 'voucher';
        const key = `vouchers/${voucher.student_id}/${filePrefix}-${voucher.id}-${ts}.pdf`;
        const qrUrl = this.storage.getPublicUrl(key);

        return {
            voucherData: {
                voucherNumber: voucher.id.toString(),
                student: {
                    cc: voucher.students.cc,
                    classId: voucher.class_id,
                    fullName: voucher.students.full_name,
                    fatherName: voucher.students?.student_guardians?.[0]?.guardians?.full_name || 'N/A',
                    gender: voucher.students?.gender || 'N/A',
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
                totalPaid,
                outstandingBalance,
                lateFeeAmount,
                qrUrl,
                paidStamp,
                showDiscount: true,
                surchargeWaived: voucher.surcharge_waived,
                totalSurcharge: Number(voucher.total_arrear_surcharge || 0),
                arrearsHistory: feeHeads
                    .filter(fh => fh.isArrear)
                    .map(fh => ({
                        date: fh.feeDate || 'N/A',
                        head: fh.originalDescription, // USE ORIGINAL NAME WITHOUT PREFIX
                        amount: fh.netAmount.toLocaleString(),
                        totalAmount: fh.netAmount.toLocaleString(), // FeeChallanPDF calculates running total
                        target_month: fh.target_month,
                        academic_year: fh.academic_year,
                    })),
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

        for (const { headId } of parsedDistributions) {
            const head = voucherHeadMap.get(headId);
            if (!head) {
                throw new BadRequestException(
                    `Voucher head #${headId} does not belong to voucher #${voucherId}.`,
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
                        },
                    })
                    : [];
                const studentFeeMap = new Map(studentFees.map((fee) => [fee.id, fee]));

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

                // Rule: If all main heads are paid, the voucher is marked as PAID.
                const allMainHeadsPaid = remainingHeads.lte(0);

                const anyHeadDeposited = refreshed.voucher_heads.some((h) =>
                    new Prisma.Decimal(h.amount_deposited as any ?? 0).gt(0),
                );
                const hasAnyDeposit = anyHeadDeposited || depositedLS.gt(0);

                let nextVoucherStatus = refreshed.status ?? 'UNPAID';
                if (allMainHeadsPaid) {
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

    async savePaidPdf(voucherId: number, pdfBuffer: Buffer) {
        const voucher = await this.prisma.vouchers.findUnique({ where: { id: voucherId } });
        if (!voucher) throw new NotFoundException(`Voucher ${voucherId} not found`);

        const key = `vouchers/${voucher.student_id}/paid-voucher-${voucherId}-${Date.now()}.pdf`;
        const pdfUrl = await this.storage.upload(key, pdfBuffer);
        await this.prisma.vouchers.update({ where: { id: voucherId }, data: { pdf_url: pdfUrl } });
        return { pdf_url: pdfUrl };
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
                });

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

                const paidPortion = new Prisma.Decimal(head.amount_deposited as any ?? 0);
                const canonAmt = new Prisma.Decimal(oldFee.amount ?? oldFee.amount_before_discount ?? 0);
                const grossOld = new Prisma.Decimal(oldFee.amount_before_discount ?? oldFee.amount ?? 0);

                const paidGross = canonAmt.gt(0)
                    ? grossOld.mul(paidPortion).div(canonAmt)
                    : paidPortion;
                const unpaidGross = Prisma.Decimal.max(grossOld.sub(paidGross), new Prisma.Decimal(0));
                const unpaidNet = Prisma.Decimal.max(canonAmt.sub(paidPortion), new Prisma.Decimal(0));

                // ── Compute prefixes from student_fees source of truth, not from head cache.
                const { prefixPaid, prefixBalance } = this.buildSplitPrefixes((oldFee as any).description_prefix);

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
                        amount: paidPortion,
                        bundle_id: oldFee.bundle_id,
                        fee_date: oldFee.fee_date,
                        amount_paid: paidPortion,
                        description_prefix: prefixPaid,   // ← from source of truth
                    },
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
                        fee_date: oldFee.fee_date,
                        amount_paid: new Prisma.Decimal(0),
                        description_prefix: prefixBalance,  // ← from source of truth
                    },
                });

                await tx.deposit_allocations.updateMany({
                    where: { student_fee_id: oldFeeId, voucher_id: voucherId },
                    data: { student_fee_id: paidSf.id },
                });

                await tx.voucher_heads.deleteMany({ where: { student_fee_id: oldFeeId } });
                await tx.student_fees.delete({ where: { id: oldFeeId } });

                // ── Store both new IDs AND the prefixes so voucher_heads creation below
                //    can write the correct description_prefix without going back to the DB.
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

            // ── Step 5: Compute arrear / surcharge totals for each split side.
            const getTotals = (rows: HeadInsert[]) => {
                let arrears = new Prisma.Decimal(0);
                let surcharges = new Prisma.Decimal(0);
                for (const row of rows) {
                    const head = sortedHeads.find(h => h.student_fee_id === row.student_fee_id);
                    const fee = head?.student_fees;
                    if (!fee) continue;

                    const isSurcharge = (fee as any).is_arrear_surcharge === true;
                    const isArrear = !isSurcharge
                        && fee.fee_date
                        && original.fee_date
                        && new Date(fee.fee_date) < new Date(original.fee_date);

                    if (isSurcharge) surcharges = surcharges.add(row.net_amount);
                    else if (isArrear) arrears = arrears.add(row.net_amount);
                }
                return { arrears, surcharges };
            };

            const paidTots = getTotals(paidHeadRows);
            const unpaidTots = getTotals(unpaidHeadRows);

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
                    total_arrears: paidTots.arrears,
                    total_arrear_surcharge: paidTots.surcharges,
                },
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
                    total_arrears: unpaidTots.arrears,
                    total_arrear_surcharge: unpaidTots.surcharges,
                },
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
                })),
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
                })),
            });

            // ── Step 8: Void the original voucher.
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
                if (!fee) return { ...h, isArrear: false, isSurcharge: false };
                
                const feeMonth = fee.month ?? fee.target_month;
                const feeYear = fee.academic_year || '';
                const voucherMonth = voucher.month;
                const voucherYear = voucher.academic_year || '';
                const isSurchargeTotal = fee.is_arrear_surcharge === true;
                let isArrear = false;

                // fee_date is the canonical source of truth for "which period does this fee belong to?"
                // If fee_date matches the voucher's fee_date, this head is NOT an arrear even if
                // the calendar month on the voucher differs (happens when a voucher is re-issued).
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
                return { ...h, isArrear, is_arrear: isArrear, isSurcharge: isSurchargeTotal, is_surcharge: isSurchargeTotal };
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
            const isSurchargeTotal = fee.is_arrear_surcharge === true;
            let isArrear = false;
            
            const getAcademicMonthIndex = (m: number) => m >= 8 ? m - 8 : m + 4;

            // fee_date is the canonical source of truth for "which period does this fee belong to?"
            // If fee_date matches the voucher's fee_date, this head is NOT an arrear.
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

            // Overwrite stored balance with the canonical derived value and attach UI flags
            updatedHeads.push({
                ...h,
                balance: headRem.toString(), // Stringify for reliable JSON serialization
                isArrear,
                is_arrear: isArrear,
                isSurcharge: isSurchargeTotal,
                is_surcharge: isSurchargeTotal
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

        // Rule: If all main fee heads are fully paid (remTotal <= 0), it's PAID regardless of late fees.
        const allHeadsPaid = totalRemHeads.lte(0);

        const anyDep = anyHeadPaidSomewhere || depLS.gt(0);

        if (allHeadsPaid) {
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
                status: 'ENROLLED',
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

        // ── Batch arrear lookup & Surcharge discovery ─────────────────────────
        const arrearCutoff = feeDateObj ?? (filters.issue_date ? new Date(filters.issue_date) : null);

        if (arrearCutoff && studentIds.length > 0) {
            for (const student of eligibleStudents) {
                // Use the refactored computeArrears to handle surcharges and IDs consistently
                const arrears = await this.computeArrears(student.student_id, arrearCutoff, (filters as any).waive_surcharge, false);

                // Merge arrear IDs and surcharge IDs into the student's fee list
                // Prepend them so they appear at the top/as arrears
                const allArrearIds = [...arrears.arrear_fee_ids, ...arrears.surcharge_fee_ids];

                for (const id of allArrearIds) {
                    if (!student.fee_ids.includes(id)) {
                        student.fee_ids.unshift(id);
                        student.fee_lines.unshift({ student_fee_id: id, discount_amount: 0 });
                    }
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
    async computeArrears(studentId: number, targetFeeDate: Date, waiveSurcharge = false, persist = true, tx?: Prisma.TransactionClient) {
        const client = tx || this.prisma;
        console.log(`[Arrears] Computing for Student: ${studentId}, Before: ${targetFeeDate.toISOString()}, Waive: ${waiveSurcharge}, Persist: ${persist}`);

        // 1. Fetch Candidates (Normal Arrears)
        const candidates = await client.student_fees.findMany({
            where: {
                student_id: studentId,
                fee_date: { lt: targetFeeDate },
                status: { notIn: ['PAID'] as any[] },
                is_arrear_surcharge: false,
            },
            include: {
                fee_types: true,
            },
            orderBy: { fee_date: 'asc' },
        });

        const rows: any[] = [];
        let totalArrearsCount = new Prisma.Decimal(0);
        const arrearFeeIds: number[] = [];
        const distinctGroups = new Map<string, { date: Date, target_month: number, academic_year: string }>();

        for (const fee of candidates) {
            const amount = new Prisma.Decimal(fee.amount ?? fee.amount_before_discount ?? 0);
            const paid = new Prisma.Decimal(fee.amount_paid ?? 0);
            const outstanding = amount.sub(paid);

            if (outstanding.lte(0)) continue;

            totalArrearsCount = totalArrearsCount.add(outstanding);
            arrearFeeIds.push(fee.id);

            const dateStr = fee.fee_date ? fee.fee_date.toISOString().split('T')[0] : 'undated';
            if (fee.fee_date && !distinctGroups.has(dateStr)) {
                distinctGroups.set(dateStr, {
                    date: fee.fee_date,
                    target_month: fee.target_month,
                    academic_year: fee.academic_year
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

        // 2. Handle Surcharges
        const surchargeFeeIds: number[] = [];
        let totalSurcharge = new Prisma.Decimal(0);

        // Potential surcharge is ALWAYS calculated based on distinct months, regardless of waiver
        if (distinctGroups.size > 0) {
            totalSurcharge = new Prisma.Decimal(distinctGroups.size * 1000);

            // If we are NOT waiving, we proceed to ensure records exist
            if (!waiveSurcharge) {
                const surchargeFeeType = await this.getOrCreateSurchargeFeeType(tx);

                for (const group of Array.from(distinctGroups.values())) {
                    let surchargeRecord: any = null;

                    if (persist) {
                        // Deduplicate: check for existing surcharge record for this student + date
                        surchargeRecord = await client.student_fees.findFirst({
                            where: {
                                student_id: studentId,
                                fee_date: group.date,
                                is_arrear_surcharge: true,
                            }
                        });

                        if (!surchargeRecord) {
                            surchargeRecord = await client.student_fees.create({
                                data: {
                                    student_id: studentId,
                                    fee_type_id: surchargeFeeType.id,
                                    amount: new Prisma.Decimal(1000),
                                    amount_before_discount: new Prisma.Decimal(1000),
                                    fee_date: group.date,
                                    target_month: group.target_month,
                                    academic_year: group.academic_year,
                                    status: 'NOT_ISSUED',
                                    is_arrear_surcharge: true,
                                    month: group.target_month,
                                }
                            });
                        }
                    }

                    // If we persisted (or found existing), add to the list
                    if (surchargeRecord) {
                        if (surchargeRecord.status !== 'PAID') {
                            const sAmt = new Prisma.Decimal(surchargeRecord.amount ?? 1000);
                            const sPaid = new Prisma.Decimal(surchargeRecord.amount_paid ?? 0);
                            const sRem = sAmt.sub(sPaid);

                            if (sRem.gt(0)) {
                                surchargeFeeIds.push(surchargeRecord.id);
                                rows.push({
                                    student_fee_id: surchargeRecord.id,
                                    fee_type: "Late Payment Surcharge",
                                    fee_date: group.date.toISOString().split('T')[0],
                                    amount: sAmt.toFixed(2),
                                    amount_paid: sPaid.toFixed(2),
                                    outstanding: sRem.toFixed(2),
                                    target_month: group.target_month,
                                    academic_year: group.academic_year,
                                    isSurcharge: true
                                });
                            }
                        }
                    } else {
                        // If not persisting (preview mode), just add a virtual row
                        rows.push({
                            student_fee_id: -1, // Virtual ID
                            fee_type: "Late Payment Surcharge",
                            fee_date: group.date.toISOString().split('T')[0],
                            amount: "1000.00",
                            amount_paid: "0.00",
                            outstanding: "1000.00",
                            target_month: group.target_month,
                            academic_year: group.academic_year,
                            isSurcharge: true
                        });
                    }
                }
            }
        }

        return {
            total_arrears: Number(totalArrearsCount.toFixed(2)),
            total_surcharge: Number(totalSurcharge.toFixed(2)),
            arrear_fee_ids: arrearFeeIds,
            surcharge_fee_ids: surchargeFeeIds,
            rows,
        };
    }

    private async getOrCreateSurchargeFeeType(tx?: Prisma.TransactionClient) {
        const client = tx || this.prisma;
        let ft = await client.fee_types.findFirst({
            where: { description: 'Late Payment Surcharge' }
        });

        if (!ft) {
            ft = await client.fee_types.create({
                data: {
                    description: 'Late Payment Surcharge',
                    freq: 'ONE_TIME',
                    priority_order: 999, // Appear last
                    breakup: {}
                }
            });
        }
        return ft;
    }

    async remove(id: number) {
        const voucher = await this.prisma.vouchers.findUnique({
            where: { id },
            include: { voucher_heads: true }
        });

        if (!voucher) {
            throw new NotFoundException(`Voucher #${id} not found`);
        }

        // Only UNPAID vouchers can be deleted to safely reset fee heads.
        if (voucher.status !== 'UNPAID' && voucher.status !== 'OVERDUE') {
            throw new BadRequestException(`Only UNPAID or OVERDUE vouchers can be deleted. This voucher is ${voucher.status}.`);
        }

        return await this.prisma.$transaction(async (tx) => {
            // 1. Reset associated student_fees to NOT_ISSUED
            const feeIds = voucher.voucher_heads.map(h => h.student_fee_id);
            if (feeIds.length > 0) {
                await tx.student_fees.updateMany({
                    where: { id: { in: feeIds } },
                    data: {
                        status: 'NOT_ISSUED',
                        issue_date: null,
                        due_date: null,
                        validity_date: null,
                        amount_paid: 0
                    }
                });
            }

            // 2. Delete deposit_allocations for this voucher
            await tx.deposit_allocations.deleteMany({
                where: { voucher_id: id }
            });

            // 3. Delete voucher_heads for this voucher
            await tx.voucher_heads.deleteMany({
                where: { voucher_id: id }
            });

            // 4. Delete the voucher record itsel
            const deleted = await tx.vouchers.delete({
                where: { id }
            });

            return deleted;
        }, {
            maxWait: 5000,
            timeout: 10000,
        });
    }
}
