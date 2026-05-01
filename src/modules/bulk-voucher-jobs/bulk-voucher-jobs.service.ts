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
import { VoucherPdfService } from '../voucher-pdf/voucher-pdf.service';
import { StorageService } from '../../common/storage/storage.service';
import { deriveAcademicYear } from '../../common/utils/academic-labels';
import { BulkVoucherLogicService } from '../vouchers/bulk-voucher-logic.service';
import { getMonthlyFeeDates } from './utils/bulk-date.utils';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────


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
        private readonly bulkLogic: BulkVoucherLogicService,
    ) {}

    // ── Preview ─────────────────────────────────────────────────────────────

    async preview(dto: PreviewBulkRequestDto): Promise<BulkStudentPreview[]> {
        const academicYear = dto.academic_year || deriveAcademicYear(dto.fee_date_to);

        // 1. Fetch matching student records
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

        // 2. Find students that already have any fee records issued/paid in the date range
        const issuedFees = await this.prisma.student_fees.findMany({
            where: {
                student_id: { in: studentIds },
                fee_date: {
                    gte: feeDateFrom,
                    lte: feeDateTo,
                },
                // Relax Academic Year filter to allow consolidation from previous sessions
                // academic_year: academicYear,
                status: { in: ['ISSUED', 'PAID', 'PARTIALLY_PAID'] },
            },
            select: { student_id: true },
        });
        
        const alreadyIssuedSet = new Set(issuedFees.map((f) => f.student_id));

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

        const academicYear = dto.academic_year || deriveAcademicYear(dto.fee_date_to);

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
                academic_year: academicYear,
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
                waive_surcharge: dto.waive_surcharge ?? false,
                updated_at: new Date(),
            },
        });

        // 2. Fire-and-forget async pipeline (no external queue needed)
        setImmediate(() => this.processJob(job.id, dto, feeDates, createdBy));

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
                report: true,
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
                report: true,
            },
        });
    }

    // ── Async Pipeline ──────────────────────────────────────────────────────

    private async processJob(jobId: number, dto: StartBulkJobDto, expectedFeeDates: string[], createdBy: string) {
        const jobReport: any[] = [];
        const academicYear = dto.academic_year || deriveAcademicYear(dto.fee_date_to);
        this.logger.log(
            `[Job #${jobId}] Starting: ${dto.student_ccs.length} students × ${expectedFeeDates.length} month(s).`,
        );

        try {
            await this.prisma.bulk_voucher_jobs.update({
                where: { id: jobId },
                data: { status: 'PROCESSING' },
            });
        } catch (err) {
            this.logger.error(`[Job #${jobId}] Failed to mark PROCESSING: ${(err as Error).message}`);
            return;
        }

        let successCount = 0;
        let failCountTotal = 0;
        let skipCountTotal = 0;

        try {
            const feeDateFrom = new Date(dto.fee_date_from);
            const feeDateTo = new Date(dto.fee_date_to);
            const PDF_BATCH_SIZE = 10;


            const { studentRecords, matchingFees, existingVouchers } = await this.bulkLogic.fetchBaseData({
                campus_id: dto.campus_id,
                class_id: dto.class_id,
                section_id: dto.section_id,
                fee_date_from: dto.fee_date_from,
                fee_date_to: dto.fee_date_to,
                student_ccs: dto.student_ccs,
            });

            // ── PHASE 2: BUILD WORK ITEMS + RESOLVE SKIPS (no DB calls) ─────────
            const { workItems, skips } = this.bulkLogic.resolveWorkItems({
                studentRecords,
                matchingFees,
                existingVouchers,
                fee_date_from: dto.fee_date_from,
                fee_date_to: dto.fee_date_to,
                expectedFeeDates,
                skipAlreadyIssued: dto.skip_already_issued ?? true,
                academic_year_override: dto.academic_year,
            });

            skipCountTotal = skips.length;
            jobReport.push(...skips.map(s => ({
                cc: s.cc,
                student_name: s.student_name,
                status: s.status,
                reason: s.reason,
            })));

            if (skipCountTotal > 0) {
                await this.prisma.bulk_voucher_jobs.update({
                    where: { id: jobId },
                    data: { skip_count: skipCountTotal },
                });
            }

            this.logger.log(
                `[Job #${jobId}] ${workItems.length} items to process, ${skipCountTotal} skipped upfront.`,
            );

            // ── PHASE 3: PARALLEL PDF BATCHES ────────────────────────────────────
            const pdfBuffers: Buffer[] = [];

            for (let i = 0; i < workItems.length; i += PDF_BATCH_SIZE) {
                const chunk = workItems.slice(i, i + PDF_BATCH_SIZE);

                const results = await Promise.allSettled(
                    chunk.map((item) => this.processWorkItem(item, dto, createdBy)),
                );

                let chunkSuccess = 0;
                let chunkFail = 0;
                let chunkSkip = 0;

                for (let j = 0; j < results.length; j++) {
                    const result = results[j];
                    const workItem = chunk[j];
                    if (result.status === 'fulfilled') {
                        pdfBuffers.push(result.value.buffer);
                        chunkSuccess++;
                        successCount++;
                        
                        jobReport.push({
                            cc: workItem.cc,
                            student_name: workItem.student.full_name,
                            pdf_url: result.value.url,
                            status: 'SUCCESS',
                        });
                    } else {
                        const errorMsg = String(result.reason);
                        if (errorMsg.includes('already fully paid') || errorMsg.includes('No voucher needed')) {
                            chunkSkip++;
                            skipCountTotal++;
                            jobReport.push({
                                cc: workItem.cc,
                                student_name: workItem.student.full_name,
                                status: 'SKIPPED',
                                reason: 'All fee heads for this period are already fully paid',
                            });
                        } else {
                            this.logger.error(`[Job #${jobId}] Work item failed: ${errorMsg}`);
                            chunkFail++;
                            failCountTotal++;

                            jobReport.push({
                                cc: workItem.cc,
                                student_name: workItem.student.full_name,
                                status: 'FAILED',
                                error: errorMsg,
                            });
                        }
                    }
                }

                await this.prisma.bulk_voucher_jobs.update({
                    where: { id: jobId },
                    data: {
                        ...(chunkSuccess > 0 ? { success_count: { increment: chunkSuccess } } : {}),
                        ...(chunkFail > 0 ? { fail_count: { increment: chunkFail } } : {}),
                        ...(chunkSkip > 0 ? { skip_count: { increment: chunkSkip } } : {}),
                    },
                });

                this.logger.log(
                    `[Job #${jobId}] Batch ${Math.floor(i / PDF_BATCH_SIZE) + 1}/${Math.ceil(workItems.length / PDF_BATCH_SIZE)}: ${chunkSuccess} ok, ${chunkFail} failed, ${chunkSkip} skipped`,
                );
            }

            // ── PHASE 4: MERGE & FINALIZE ─────────────────────────────────────────
            let mergedPdfUrl: string | null = null;
            if (pdfBuffers.length > 0) {
                try {
                    this.logger.log(`[Job #${jobId}] Merging ${pdfBuffers.length} PDFs...`);
                    const mergedBuffer = await this.voucherPdfService.mergePdfs(pdfBuffers);
                    const mergedKey = `bulk-vouchers/job-${jobId}-${Date.now()}.pdf`;
                    mergedPdfUrl = await this.storage.upload(mergedKey, mergedBuffer);
                } catch (mergeErr) {
                    this.logger.error(`[Job #${jobId}] PDF Merging failed: ${(mergeErr as Error).message}`);
                }
            }

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
                    report: jobReport as any,
                },
            });

            this.logger.log(
                `[Job #${jobId}] Complete → status=${finalStatus} success=${successCount} skip=${skipCountTotal} fail=${failCountTotal}`,
            );
        } catch (fatalError) {
            this.logger.error(`[Job #${jobId}] Fatal error in job processing: ${(fatalError as Error).message}`, (fatalError as Error).stack);
            
            const jobWasSuccessful = successCount > 0;
            let finalStatus: BulkJobStatus = 'FAILED';
            if (jobWasSuccessful) finalStatus = 'PARTIAL_FAILURE';

            await this.prisma.bulk_voucher_jobs.update({
                where: { id: jobId },
                data: { 
                    status: finalStatus,
                    report: [
                        ...jobReport,
                        {
                            status: 'FAILED',
                            error: `Fatal system error: ${(fatalError as Error).message}`,
                        },
                    ] as any,
                },
            });
        }
    }

    // ── Per-item worker ─────────────────────────────────────────────────────

    private async processWorkItem(
        item: { cc: number; dateStr: string; fees: any[]; student: any; academicYear: string },
        dto: StartBulkJobDto,
        createdBy: string,
    ): Promise<{ buffer: Buffer; url: string }> {
        const { cc, dateStr, fees: feesForThisVoucher, student } = item;

        const arrearsResult = await this.vouchersService.computeArrears(
            cc,
            new Date(dateStr),
            dto.waive_surcharge ?? false,
        );
        const arrearFeeIds = arrearsResult.arrear_fee_ids ?? [];
        const arrearFeeLines = (arrearsResult.rows ?? [])
            .filter((r) => !r.isSurcharge)
            .map((r) => ({ student_fee_id: r.student_fee_id, discount_amount: 0, discount_label: '' }));

        const currentFeeLines = feesForThisVoucher.map((f: any) => {
            const gross = Number(f.amount_before_discount || f.amount || 0);
            const net = Number(f.amount || 0);
            return {
                student_fee_id: f.id,
                discount_amount: Math.max(0, gross - net),
                discount_label: gross > net ? 'Discount' : '',
            };
        });

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
            waive_surcharge: dto.waive_surcharge ?? false,
            waived_by: createdBy,
            academic_year: item.academicYear,
            fee_date: dateStr,
            precedence: 1,
            orderedFeeIds: [...arrearFeeIds, ...feesForThisVoucher.map((f: any) => f.id)],
            fee_lines: [...arrearFeeLines, ...currentFeeLines],
            pre_computed_surcharge_groups: arrearsResult.surcharge_groups,
        });

        return this.vouchersService.generatePdfBuffer(voucher.id);
    }
}
