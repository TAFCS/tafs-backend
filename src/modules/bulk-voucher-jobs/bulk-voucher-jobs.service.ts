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
// Month / PDF label helpers  (shared by processJob & processWorkItem)
// ─────────────────────────────────────────────────────────────────────────────

const PDF_MONTHS = ['August','September','October','November','December','January','February','March','April','May','June','July'];
const PDF_MONTH_TO_NUM: Record<string, number> = { August:8,September:9,October:10,November:11,December:12,January:1,February:2,March:3,April:4,May:5,June:6,July:7 };

function getMonthYearLabel(m: number, academicYear: string): string {
    const monthName = PDF_MONTHS.find((_, i) => PDF_MONTH_TO_NUM[PDF_MONTHS[i]] === m) || '';
    const parts = academicYear.split('-').map(y => y.trim());
    const year = m >= 8 ? parts[0] : (parts[1] || parts[0]);
    return `${monthName.slice(0, 3)} ${year.slice(-2)}`;
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

        // 2. Find students that already have any fee records issued/paid in the date range
        const issuedFees = await this.prisma.student_fees.findMany({
            where: {
                student_id: { in: studentIds },
                fee_date: {
                    gte: feeDateFrom,
                    lte: feeDateTo,
                },
                academic_year: dto.academic_year,
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
                updated_at: new Date(),
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

        const feeDateFrom = new Date(dto.fee_date_from);
        const feeDateTo = new Date(dto.fee_date_to);
        const expectedCountPerStudent = expectedFeeDates.length;
        const PDF_BATCH_SIZE = 10;

        // ── PHASE 1: BULK PRE-FETCH (4 parallel DB queries) ─────────────────
        const [bankAccount, studentRecords, allEligibleFees, existingVouchers] = await Promise.all([
            this.prisma.bank_accounts.findUnique({ where: { id: dto.bank_account_id } }),
            this.prisma.students.findMany({
                where: { cc: { in: dto.student_ccs }, deleted_at: null },
                select: {
                    cc: true,
                    full_name: true,
                    gender: true,
                    gr_number: true,
                    family_id: true,
                    class_id: true,
                    campus_id: true,
                    section_id: true,
                    classes: { select: { description: true } },
                    sections: { select: { description: true } },
                    campuses: { select: { campus_name: true } },
                    student_guardians: {
                        select: {
                            relationship: true,
                            is_primary_contact: true,
                            guardians: { select: { full_name: true } },
                        },
                    },
                },
            }),
            this.prisma.student_fees.findMany({
                where: {
                    student_id: { in: dto.student_ccs },
                    fee_date: { gte: feeDateFrom, lte: feeDateTo },
                    academic_year: dto.academic_year,
                    status: 'NOT_ISSUED',
                },
                select: {
                    id: true,
                    student_id: true,
                    fee_date: true,
                    target_month: true,
                    month: true,
                    amount: true,
                    amount_before_discount: true,
                    fee_type_id: true,
                    fee_types: { select: { description: true, priority_order: true } },
                },
            }),
            this.prisma.vouchers.findMany({
                where: {
                    student_id: { in: dto.student_ccs },
                    fee_date: { gte: feeDateFrom, lte: feeDateTo },
                    status: { not: 'VOID' },
                },
                select: { student_id: true, fee_date: true },
            }),
        ]);

        const studentMap = new Map(studentRecords.map((s) => [s.cc, s]));

        // Group fees: cc → dateStr → fees[]
        type FeeRecord = typeof allEligibleFees[0];
        const feesByStudentDate = new Map<number, Map<string, FeeRecord[]>>();
        for (const f of allEligibleFees) {
            const dateKey = f.fee_date ? f.fee_date.toISOString().split('T')[0] : null;
            if (!dateKey) continue;
            if (!feesByStudentDate.has(f.student_id)) feesByStudentDate.set(f.student_id, new Map());
            const dateMap = feesByStudentDate.get(f.student_id)!;
            const list = dateMap.get(dateKey) ?? [];
            list.push(f);
            dateMap.set(dateKey, list);
        }

        // Set of "cc|dateStr" keys that already have a non-VOID voucher
        const existingVoucherKeys = new Set(
            existingVouchers
                .filter(v => v.fee_date)
                .map(v => `${v.student_id}|${v.fee_date!.toISOString().split('T')[0]}`),
        );

        // Siblings bulk fetch (needs familyIds from studentRecords)
        const familyIds = studentRecords.map((s) => s.family_id).filter(Boolean);
        const allSiblings = await this.prisma.students.findMany({
            where: { family_id: { in: familyIds as number[] }, deleted_at: null, status: 'ENROLLED' },
            include: {
                classes: { select: { description: true } },
                sections: { select: { description: true } },
            },
        });
        const siblingsMap = new Map<number, typeof allSiblings>();
        for (const s of allSiblings) {
            if (!s.family_id) continue;
            const list = siblingsMap.get(s.family_id) ?? [];
            list.push(s);
            siblingsMap.set(s.family_id, list);
        }

        // ── PHASE 2: BUILD WORK ITEMS + RESOLVE SKIPS (no DB calls) ─────────
        type WorkItem = { cc: number; dateStr: string; fees: FeeRecord[]; student: typeof studentRecords[0] };
        const workItems: WorkItem[] = [];
        let skipCountTotal = 0;

        for (const cc of dto.student_ccs) {
            const student = studentMap.get(cc);
            if (!student || !student.campus_id || !student.class_id) {
                this.logger.warn(`[Job #${jobId}] CC ${cc} missing campus/class — skipping ${expectedCountPerStudent} units`);
                skipCountTotal += expectedCountPerStudent;
                continue;
            }

            const dateMap = feesByStudentDate.get(cc);
            const datesFound = dateMap ? Array.from(dateMap.keys()) : [];

            for (const dateStr of datesFound) {
                if (existingVoucherKeys.has(`${cc}|${dateStr}`) && (dto.skip_already_issued ?? true)) {
                    skipCountTotal++;
                } else {
                    workItems.push({ cc, dateStr, fees: dateMap!.get(dateStr)!, student });
                }
            }

            // Months with no NOT_ISSUED fees count as skipped
            const gap = expectedCountPerStudent - datesFound.length;
            if (gap > 0) skipCountTotal += gap;
        }

        if (skipCountTotal > 0) {
            await this.prisma.bulk_voucher_jobs.update({
                where: { id: jobId },
                data: { skip_count: { increment: skipCountTotal } },
            });
        }

        this.logger.log(
            `[Job #${jobId}] ${workItems.length} items to process, ${skipCountTotal} skipped upfront.`,
        );

        // ── PHASE 3: PARALLEL PDF BATCHES ────────────────────────────────────
        let successCount = 0;
        let failCountTotal = 0;
        const pdfBuffers: Buffer[] = [];

        for (let i = 0; i < workItems.length; i += PDF_BATCH_SIZE) {
            const chunk = workItems.slice(i, i + PDF_BATCH_SIZE);

            const results = await Promise.allSettled(
                chunk.map((item) => this.processWorkItem(item, dto, bankAccount, siblingsMap)),
            );

            let chunkSuccess = 0;
            let chunkFail = 0;
            for (const result of results) {
                if (result.status === 'fulfilled') {
                    pdfBuffers.push(result.value);
                    chunkSuccess++;
                    successCount++;
                } else {
                    this.logger.error(`[Job #${jobId}] Work item failed: ${result.reason}`);
                    chunkFail++;
                    failCountTotal++;
                }
            }

            await this.prisma.bulk_voucher_jobs.update({
                where: { id: jobId },
                data: {
                    ...(chunkSuccess > 0 ? { success_count: { increment: chunkSuccess } } : {}),
                    ...(chunkFail > 0 ? { fail_count: { increment: chunkFail } } : {}),
                },
            });

            this.logger.log(
                `[Job #${jobId}] Batch ${Math.floor(i / PDF_BATCH_SIZE) + 1}/${Math.ceil(workItems.length / PDF_BATCH_SIZE)}: ${chunkSuccess} ok, ${chunkFail} failed`,
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
            data: { status: finalStatus, merged_pdf_url: mergedPdfUrl },
        });

        this.logger.log(
            `[Job #${jobId}] Complete → status=${finalStatus} success=${successCount} skip=${skipCountTotal} fail=${failCountTotal}`,
        );
    }

    // ── Per-item worker ─────────────────────────────────────────────────────

    private async processWorkItem(
        item: { cc: number; dateStr: string; fees: any[]; student: any },
        dto: StartBulkJobDto,
        bankAccount: any,
        siblingsMap: Map<number, any[]>,
    ): Promise<Buffer> {
        const { cc, dateStr, fees: feesForThisVoucher, student } = item;

        // ── Fetch arrears (unpaid fees whose fee_date < this voucher's fee_date) ──
        const arrearsResult = await this.vouchersService.computeArrears(cc, new Date(dateStr));
        const arrearFeeIds = arrearsResult.arrear_fee_ids ?? [];
        const arrearRows = arrearsResult.rows ?? [];

        // Arrear lines use outstanding balance as net (no discount)
        const arrearFeeLines = arrearRows.map((r) => ({
            student_fee_id: r.student_fee_id,
            discount_amount: 0,
            discount_label: '',
        }));

        const currentFeeLines = feesForThisVoucher.map((f: any) => {
            const gross = Number(f.amount_before_discount || f.amount || 0);
            const net = Number(f.amount || 0);
            return {
                student_fee_id: f.id,
                discount_amount: Math.max(0, gross - net),
                discount_label: gross > net ? 'Discount' : '',
            };
        });

        // Arrear IDs go first (same order as single-voucher flow)
        const allOrderedFeeIds = [...arrearFeeIds, ...feesForThisVoucher.map((f: any) => f.id)];
        const allFeeLines = [...arrearFeeLines, ...currentFeeLines];

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
            orderedFeeIds: allOrderedFeeIds,
            fee_lines: allFeeLines,
        });

        const fatherG =
            (student.student_guardians || []).find((g: any) => g.relationship === 'FATHER') ||
            (student.student_guardians || []).find((g: any) => g.is_primary_contact);
        const fatherName = fatherG?.guardians?.full_name || 'N/A';

        // Group tuition fees to consolidate consecutive months
        const tuitionGroups: Record<string, any[]> = {};
        const otherHeads: any[] = [];

        feesForThisVoucher.forEach((f: any) => {
            const baseDesc = f.fee_types?.description || 'Fee';
            const isTuition = baseDesc.toLowerCase().includes('tuition');
            if (isTuition) {
                if (!tuitionGroups[baseDesc]) tuitionGroups[baseDesc] = [];
                tuitionGroups[baseDesc].push(f);
            } else {
                const gross = Number(f.amount_before_discount || f.amount || 0);
                const net = Number(f.amount || 0);
                const disc = Math.max(0, gross - net);
                let desc = baseDesc;
                const m = f.target_month || f.month;
                if (m) desc = `${baseDesc} (${getMonthYearLabel(m, dto.academic_year).toUpperCase()})`;

                otherHeads.push({ 
                    description: desc, 
                    amount: gross, 
                    discount: disc, 
                    netAmount: net, 
                    discountLabel: disc > 0 ? 'Discount' : '' 
                });
            }
        });

        const mergedTuitionHeads: any[] = [];
        Object.keys(tuitionGroups).forEach(baseDesc => {
            const group = tuitionGroups[baseDesc];
            
            // Helper for sequencing (Aug=0... Jul=11)
            const getSeq = (m: number) => {
                const startYear = parseInt(dto.academic_year.split('-')[0]) || 0;
                return startYear * 12 + (m >= 8 ? m - 8 : m + 4);
            };

            group.sort((a, b) => getSeq(a.target_month || a.month || 0) - getSeq(b.target_month || b.month || 0));

            // Identify consecutive ranges
            const ranges: any[][] = [];
            let currentRange: any[] = [];
            group.forEach((f, idx) => {
                const m = f.target_month || f.month || 0;
                if (idx === 0) {
                    currentRange.push(f);
                } else {
                    const prevM = group[idx - 1].target_month || group[idx - 1].month || 0;
                    if (getSeq(m) === getSeq(prevM) + 1) {
                        currentRange.push(f);
                    } else {
                        ranges.push(currentRange);
                        currentRange = [f];
                    }
                }
            });
            ranges.push(currentRange);

            // Consolidate each range
            ranges.forEach(range => {
                const firstM = range[0].target_month || range[0].month || 0;
                const lastM = range[range.length - 1].target_month || range[range.length - 1].month || 0;
                const gross = range.reduce((s, f) => s + Number(f.amount_before_discount || f.amount || 0), 0);
                const net = range.reduce((s, f) => s + Number(f.amount || 0), 0);
                const disc = Math.max(0, gross - net);

                let labelSuffix = `(${getMonthYearLabel(firstM, dto.academic_year).toUpperCase()})`;
                if (range.length > 1) {
                    labelSuffix = `(${getMonthYearLabel(firstM, dto.academic_year).toUpperCase()} - ${getMonthYearLabel(lastM, dto.academic_year).toUpperCase()})`;
                }

                mergedTuitionHeads.push({
                    description: `${baseDesc} ${labelSuffix}`,
                    amount: gross,
                    discount: disc,
                    netAmount: net,
                    discountLabel: disc > 0 ? 'Discount' : ''
                });
            });
        });

        const feeHeadsForPdf = [...otherHeads, ...mergedTuitionHeads];

        // ── Prepend arrear heads to PDF (same style as single-voucher flow) ──
        const arrearHeadsForPdf = arrearRows.map((r) => ({
            description: `${r.fee_type} (ARREAR – ${r.fee_date})`,
            amount: Number(r.outstanding),
            discount: 0,
            netAmount: Number(r.outstanding),
            discountLabel: '',
            isArrear: true,
        }));

        const allPdfHeads = [...arrearHeadsForPdf, ...feeHeadsForPdf];
        const currentFeesTotal = feesForThisVoucher.reduce((sum: number, f: any) => sum + Number(f.amount || 0), 0);
        const arrearsTotal = arrearRows.reduce((sum, r) => sum + Number(r.outstanding), 0);
        const grandTotal = currentFeesTotal + arrearsTotal;

        const monthNums = [...new Set(
            feesForThisVoucher.map((f: any) => f.target_month || f.month).filter(Boolean) as number[]
        )].sort((a, b) => a - b);
        const monthLabel = monthNums.length > 0
            ? monthNums.map(m => getMonthYearLabel(m, dto.academic_year)).join(' / ')
            : new Date(dateStr).toLocaleString('default', { month: 'long', year: 'numeric' });

        const pdfBuffer = await this.voucherPdfService.generateVoucherPdf({
            voucherNumber: voucher.id.toString(),
            student: {
                cc: student.cc,
                classId: student.class_id,
                fullName: student.full_name,
                fatherName,
                gender: student.gender || 'N/A',
                grNumber: student.gr_number || 'N/A',
                className: student.classes?.description || 'N/A',
                sectionName: student.sections?.description || 'N/A',
            },
            siblings: (siblingsMap.get(student.family_id) || [])
                .filter((s: any) => s.cc !== student.cc)
                .map((s: any) => ({
                    cc: s.cc,
                    fullName: s.full_name,
                    grNumber: s.gr_number || 'N/A',
                    className: s.classes?.description || 'N/A',
                    sectionName: s.sections?.description || 'N/A',
                })),
            campusName: student.campuses?.campus_name || 'Main Campus',
            academicYear: dto.academic_year,
            month: monthLabel,
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
            feeHeads: allPdfHeads,
            totalAmount: grandTotal,
            lateFeeAmount: dto.apply_late_fee ? (dto.late_fee_amount ?? 1000) : 0,
            qrUrl: undefined, // will be set after upload
            arrearsHistory: arrearRows.map((r, idx) => {
                const runningTotal = arrearRows
                    .slice(0, idx + 1)
                    .reduce((sum, row) => sum + Number(row.outstanding), 0);
                return {
                    date: r.fee_date,
                    head: r.fee_type,
                    amount: Number(r.outstanding).toLocaleString(),
                    totalAmount: runningTotal.toLocaleString(),
                    target_month: r.target_month,
                    academic_year: r.academic_year,
                };
            }),
        });

        // Upload PDF without QR to get the real DO URL
        const key = `vouchers/${student.cc}/voucher-${voucher.id}-${Date.now()}.pdf`;
        const pdfUrl = await this.storage.upload(key, pdfBuffer);
        await this.prisma.vouchers.update({ where: { id: voucher.id }, data: { pdf_url: pdfUrl } });

        // Regenerate PDF with the real QR URL (same pattern as single-voucher flow)
        const pdfBufferWithQr = await this.voucherPdfService.generateVoucherPdf({
            voucherNumber: voucher.id.toString(),
            student: {
                cc: student.cc,
                classId: student.class_id,
                fullName: student.full_name,
                fatherName,
                gender: student.gender || 'N/A',
                grNumber: student.gr_number || 'N/A',
                className: student.classes?.description || 'N/A',
                sectionName: student.sections?.description || 'N/A',
            },
            siblings: (siblingsMap.get(student.family_id) || [])
                .filter((s: any) => s.cc !== student.cc)
                .map((s: any) => ({
                    cc: s.cc,
                    fullName: s.full_name,
                    grNumber: s.gr_number || 'N/A',
                    className: s.classes?.description || 'N/A',
                    sectionName: s.sections?.description || 'N/A',
                })),
            campusName: student.campuses?.campus_name || 'Main Campus',
            academicYear: dto.academic_year,
            month: monthLabel,
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
            feeHeads: allPdfHeads,
            totalAmount: grandTotal,
            lateFeeAmount: dto.apply_late_fee ? (dto.late_fee_amount ?? 1000) : 0,
            qrUrl: pdfUrl,
            arrearsHistory: arrearRows.map((r, idx) => {
                const runningTotal = arrearRows
                    .slice(0, idx + 1)
                    .reduce((sum, row) => sum + Number(row.outstanding), 0);
                return {
                    date: r.fee_date,
                    head: r.fee_type,
                    amount: Number(r.outstanding).toLocaleString(),
                    totalAmount: runningTotal.toLocaleString(),
                    target_month: r.target_month,
                    academic_year: r.academic_year,
                };
            }),
        });

        return pdfBufferWithQr;
    }
}
