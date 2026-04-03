import {
    BadRequestException,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { BulkJobStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { VouchersService } from '../vouchers/vouchers.service';
import { PreviewBulkRequestDto } from './dto/preview-bulk-request.dto';
import { StartBulkJobDto } from './dto/start-bulk-job.dto';
import { VoucherPdfService } from './voucher-pdf.service';
import { StorageService } from '../../common/storage/storage.service';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns an array of ISO date strings (YYYY-MM-DD) for the 1st of every
 * calendar month between `from` and `to` (inclusive).
 *
 * e.g. "2025-01-01" → "2025-03-31" produces ["2025-01-01", "2025-02-01", "2025-03-01"]
 */
function getMonthlyFeeDates(from: string, to: string): string[] {
    const dates: string[] = [];
    const start = new Date(from);
    const end = new Date(to);

    // Normalise to 1st of each month
    const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    const endNormalised = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));

    while (cursor <= endNormalised) {
        dates.push(cursor.toISOString().split('T')[0]);
        cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }

    return dates;
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface BulkStudentPreview {
    cc: number;
    student_full_name: string;
    gr_number: string | null;
    class_name: string;
    section_name: string;
    is_already_issued: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class BulkVoucherJobsService {
    private readonly logger = new Logger(BulkVoucherJobsService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly vouchersService: VouchersService,
        private readonly voucherPdfService: VoucherPdfService,
        private readonly storage: StorageService,
    ) {}

    // ── Preview ─────────────────────────────────────────────────────────────

    async preview(dto: PreviewBulkRequestDto): Promise<BulkStudentPreview[]> {
        // ... (existing preview code)
        // 1. Fetch matching students
        const students = await this.prisma.students.findMany({
            where: {
                deleted_at: null,
                status: 'ENROLLED',
                campus_id: dto.campus_id,
                ...(dto.class_id ? { class_id: dto.class_id } : {}),
                ...(dto.section_id ? { section_id: dto.section_id } : {}),
            },
            select: {
                cc: true,
                full_name: true,
                gr_number: true,
                classes: { select: { description: true } },
                sections: { select: { description: true } },
            },
            orderBy: [{ classes: { description: 'asc' } }, { full_name: 'asc' }],
        });

        if (students.length === 0) return [];

        const studentIds = students.map((s) => s.cc);
        const feeDateFrom = new Date(dto.fee_date_from);
        const feeDateTo = new Date(dto.fee_date_to);

        // 2. Find students that already have any voucher in the date range
        const existingVouchers = await this.prisma.vouchers.findMany({
            where: {
                student_id: { in: studentIds },
                fee_date: {
                    gte: feeDateFrom,
                    lte: feeDateTo,
                },
                status: { not: 'VOID' },
            },
            select: { student_id: true },
        });

        const alreadyIssuedSet = new Set(existingVouchers.map((v) => v.student_id));

        // 3. Build response
        return students.map((s) => ({
            cc: s.cc,
            student_full_name: s.full_name,
            gr_number: s.gr_number ?? null,
            class_name: s.classes?.description ?? 'N/A',
            section_name: s.sections?.description ?? 'N/A',
            is_already_issued: alreadyIssuedSet.has(s.cc),
        }));
    }

    // ── Start Job ───────────────────────────────────────────────────────────

    async startJob(dto: StartBulkJobDto, createdBy: string): Promise<{ job_id: number }> {
        if (!dto.student_ccs || dto.student_ccs.length === 0) {
            throw new BadRequestException('student_ccs cannot be empty.');
        }

        const feeDates = getMonthlyFeeDates(dto.fee_date_from, dto.fee_date_to);
        if (feeDates.length === 0) {
            throw new BadRequestException(
                'fee_date_from must be before or equal to fee_date_to.',
            );
        }

        // Total work items = students × months
        const totalCount = dto.student_ccs.length * feeDates.length;

        // 1. Create the job record
        const job = await this.prisma.bulk_voucher_jobs.create({
            data: {
                created_by: createdBy,
                campus_id: dto.campus_id,
                class_id: dto.class_id ?? null,
                section_id: dto.section_id ?? null,
                academic_year: dto.academic_year,
                fee_date_from: new Date(dto.fee_date_from),
                fee_date_to: new Date(dto.fee_date_to),
                issue_date: new Date(dto.issue_date),
                due_date: new Date(dto.due_date),
                validity_date: dto.validity_date ? new Date(dto.validity_date) : null,
                bank_account_id: dto.bank_account_id,
                skip_already_issued: dto.skip_already_issued ?? true,
                apply_late_fee: dto.apply_late_fee ?? true,
                late_fee_amount: dto.late_fee_amount ?? 1000,
                status: 'PENDING',
                total_count: totalCount,
                success_count: 0,
                skip_count: 0,
                fail_count: 0,
            },
        });

        // 2. Fire-and-forget async pipeline (no external queue needed)
        setImmediate(() => this.processJob(job.id, dto, feeDates));

        return { job_id: job.id };
    }

    // ── Job Status ──────────────────────────────────────────────────────────

    async getJobStatus(jobId: number) {
        const job = await this.prisma.bulk_voucher_jobs.findUnique({
            where: { id: jobId },
            select: {
                id: true,
                status: true,
                total_count: true,
                success_count: true,
                skip_count: true,
                fail_count: true,
                merged_pdf_url: true,
                created_at: true,
                updated_at: true,
                campuses: { select: { id: true, campus_name: true } },
            },
        });

        if (!job) throw new NotFoundException(`Job #${jobId} not found.`);

        return job;
    }

    // ── Job History ─────────────────────────────────────────────────────────

    async listJobs(campusId?: number) {
        return this.prisma.bulk_voucher_jobs.findMany({
            where: {
                ...(campusId ? { campus_id: campusId } : {}),
            },
            orderBy: { created_at: 'desc' },
            take: 50,
            select: {
                id: true,
                status: true,
                total_count: true,
                success_count: true,
                skip_count: true,
                fail_count: true,
                academic_year: true,
                fee_date_from: true,
                fee_date_to: true,
                merged_pdf_url: true,
                created_at: true,
                campuses: { select: { campus_name: true } },
            },
        });
    }

    // ── Async Pipeline ──────────────────────────────────────────────────────

    private async processJob(jobId: number, dto: StartBulkJobDto, expectedFeeDates: string[]) {
        this.logger.log(
            `[Job #${jobId}] Starting processing for ${dto.student_ccs.length} students. Expected ${expectedFeeDates.length} unit(s) per student.`,
        );

        try {
            await this.prisma.bulk_voucher_jobs.update({
                where: { id: jobId },
                data: { status: 'PROCESSING' },
            });
        } catch (err) {
            this.logger.error(
                `[Job #${jobId}] Failed to mark PROCESSING: ${(err as Error).message}`,
            );
            return;
        }

        let successCount = 0;
        let skipCountTotal = 0;
        let failCountTotal = 0;
        const pdfBuffers: Buffer[] = [];

        const feeDateFrom = new Date(dto.fee_date_from);
        const feeDateTo = new Date(dto.fee_date_to);
        const expectedCountPerStudent = expectedFeeDates.length;

        // Fetch bank account info once
        const bankAccount = await this.prisma.bank_accounts.findUnique({
            where: { id: dto.bank_account_id },
        });

        // Fetch student records once for class/section/campus info
        const studentRecords = await this.prisma.students.findMany({
            where: { cc: { in: dto.student_ccs }, deleted_at: null },
            include: { 
                classes: true, 
                sections: true, 
                campuses: true 
            },
        });

        const studentMap = new Map(studentRecords.map((s) => [s.cc, s]));

        for (const cc of dto.student_ccs) {
            const student = studentMap.get(cc);
            if (!student || !student.campus_id || !student.class_id) {
                this.logger.warn(`[Job #${jobId}] Student CC ${cc} missing campus/class — skipping ${expectedCountPerStudent} units`);
                skipCountTotal += expectedCountPerStudent;
                await this.prisma.bulk_voucher_jobs.update({
                    where: { id: jobId },
                    data: { skip_count: { increment: expectedCountPerStudent } },
                });
                continue;
            }

            try {
                // 1. DISCOVER eligible fee records in the range [fee_date_from, fee_date_to]
                const allEligibleFees = await this.prisma.student_fees.findMany({
                    where: {
                        student_id: cc,
                        fee_date: {
                            gte: feeDateFrom,
                            lte: feeDateTo,
                        },
                        status: 'NOT_ISSUED',
                    },
                    include: { fee_types: true },
                });

                // 2. Group them by their actual fee_date
                const feesByDate = new Map<string, typeof allEligibleFees>();
                for (const f of allEligibleFees) {
                    const dateKey = f.fee_date ? f.fee_date.toISOString().split('T')[0] : 'no-date';
                    const list = feesByDate.get(dateKey) ?? [];
                    list.push(f);
                    feesByDate.set(dateKey, list);
                }

                const datesFound = Array.from(feesByDate.keys()).filter(d => d !== 'no-date');
                let studentProcessedUnits = 0;

                for (const dateStr of datesFound) {
                    const feesForThisVoucher = feesByDate.get(dateStr)!;
                    const feeIds = feesForThisVoucher.map(f => f.id);
                    
                    try {
                        const existing = await this.prisma.vouchers.findFirst({
                            where: {
                                student_id: cc,
                                fee_date: new Date(dateStr),
                                status: { not: 'VOID' },
                            },
                        });

                        if (existing && (dto.skip_already_issued ?? true)) {
                            skipCountTotal++;
                            await this.prisma.bulk_voucher_jobs.update({
                                where: { id: jobId },
                                data: { skip_count: { increment: 1 } },
                            });
                            studentProcessedUnits++;
                            continue;
                        }

                        // Create the voucher record
                        const voucher = await this.vouchersService.create({
                            student_id: cc,
                            campus_id: student.campus_id,
                            class_id: student.class_id,
                            section_id: student.section_id ?? undefined,
                            bank_account_id: dto.bank_account_id,
                            issue_date: dto.issue_date,
                            due_date: dto.due_date,
                            validity_date: dto.validity_date,
                            late_fee_charge: dto.apply_late_fee ?? true,
                            late_fee_amount: dto.late_fee_amount ?? 1000,
                            academic_year: dto.academic_year,
                            fee_date: dateStr,
                            precedence: 1,
                            orderedFeeIds: feeIds,
                            fee_lines: feeIds.map((feeId) => ({
                                student_fee_id: feeId,
                                discount_amount: 0,
                                discount_label: '',
                            })),
                        });

                        // ── GENERATE PDF ──
                        try {
                            const pdfBuffer = await this.voucherPdfService.generateVoucherPdf({
                                voucherNumber: voucher.id.toString(),
                                student: {
                                    cc: student.cc,
                                    fullName: student.full_name,
                                    grNumber: student.gr_number || 'N/A',
                                    className: student.classes?.description || 'N/A',
                                    sectionName: student.sections?.description || 'N/A',
                                },
                                campusName: student.campuses?.campus_name || 'Main Campus',
                                academicYear: dto.academic_year,
                                month: new Date(dateStr).toLocaleString('default', { month: 'long', year: 'numeric' }),
                                issueDate: dto.issue_date,
                                dueDate: dto.due_date,
                                validityDate: dto.validity_date || 'N/A',
                                bank: {
                                    name: bankAccount?.bank_name || 'N/A',
                                    title: bankAccount?.account_title || 'N/A',
                                    account: bankAccount?.account_number || 'N/A',
                                    iban: bankAccount?.iban || 'N/A',
                                    address: bankAccount?.bank_address || 'N/A',
                                },
                                feeHeads: feesForThisVoucher.map(f => ({
                                    description: f.fee_types?.description || 'Fee',
                                    amount: Number(f.amount),
                                    netAmount: Number(f.amount),
                                })),
                                totalAmount: feesForThisVoucher.reduce((sum, f) => sum + Number(f.amount), 0),
                                lateFeeAmount: dto.apply_late_fee ? (dto.late_fee_amount ?? 1000) : 0,
                            });

                            // Upload individual PDF
                            const key = `vouchers/${student.cc}/voucher-${voucher.id}-${Date.now()}.pdf`;
                            const pdfUrl = await this.storage.upload(key, pdfBuffer);

                            // Update voucher with PDF URL
                            await this.prisma.vouchers.update({
                                where: { id: voucher.id },
                                data: { pdf_url: pdfUrl }
                            });

                            pdfBuffers.push(pdfBuffer);
                        } catch (pdfErr) {
                            this.logger.error(`[Job #${jobId}] PDF Generation failed for voucher ${voucher.id}: ${pdfErr.message}`);
                        }

                        successCount++;
                        await this.prisma.bulk_voucher_jobs.update({
                            where: { id: jobId },
                            data: { success_count: { increment: 1 } },
                        });
                        studentProcessedUnits++;
                    } catch (err: any) {
                        failCountTotal++;
                        this.logger.error(`[Job #${jobId}] Error for CC ${cc} date ${dateStr}: ${err?.message}`);
                        await this.prisma.bulk_voucher_jobs.update({
                            where: { id: jobId },
                            data: { fail_count: { increment: 1 } },
                        });
                        studentProcessedUnits++;
                    }
                }

                const gap = expectedCountPerStudent - studentProcessedUnits;
                if (gap > 0) {
                    skipCountTotal += gap;
                    await this.prisma.bulk_voucher_jobs.update({
                        where: { id: jobId },
                        data: { skip_count: { increment: gap } },
                    });
                }
            } catch (err: any) {
                const errorGap = expectedCountPerStudent;
                failCountTotal += errorGap;
                this.logger.error(`[Job #${jobId}] Fatal student error for CC ${cc}: ${err?.message}`);
                await this.prisma.bulk_voucher_jobs.update({
                    where: { id: jobId },
                    data: { fail_count: { increment: errorGap } },
                });
            }
        }

        // ── MERGE & FINALIZE ──
        let mergedPdfUrl: string | null = null;
        if (pdfBuffers.length > 0) {
            try {
                this.logger.log(`[Job #${jobId}] Merging ${pdfBuffers.length} PDFs...`);
                const mergedBuffer = await this.voucherPdfService.mergePdfs(pdfBuffers);
                const mergedKey = `bulk-vouchers/job-${jobId}-${Date.now()}.pdf`;
                mergedPdfUrl = await this.storage.upload(mergedKey, mergedBuffer);
            } catch (mergeErr) {
                this.logger.error(`[Job #${jobId}] PDF Merging failed: ${mergeErr.message}`);
            }
        }

        // Final status
        const totalProcessedSoFar = successCount + skipCountTotal + failCountTotal;
        const jobWasSuccessful = successCount > 0;
        const hasFailures = failCountTotal > 0;

        let finalStatus: BulkJobStatus = 'DONE';
        if (!jobWasSuccessful && hasFailures) finalStatus = 'FAILED';
        else if (hasFailures) finalStatus = 'PARTIAL_FAILURE';

        await this.prisma.bulk_voucher_jobs.update({
            where: { id: jobId },
            data: { 
                status: finalStatus,
                merged_pdf_url: mergedPdfUrl,
                ...(totalProcessedSoFar > dto.student_ccs.length * expectedCountPerStudent 
                    ? { total_count: totalProcessedSoFar } 
                    : {})
            },
        });

        this.logger.log(
            `[Job #${jobId}] Complete → status=${finalStatus} success=${successCount} skip=${skipCountTotal} fail=${failCountTotal}`,
        );
    }
}
