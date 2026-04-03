import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseIntPipe,
    Post,
    Query,
    Request,
} from '@nestjs/common';
import { BulkVoucherJobsService } from './bulk-voucher-jobs.service';
import { PreviewBulkRequestDto } from './dto/preview-bulk-request.dto';
import { StartBulkJobDto } from './dto/start-bulk-job.dto';

@Controller('bulk-voucher-jobs')
export class BulkVoucherJobsController {
    constructor(private readonly bulkVoucherJobsService: BulkVoucherJobsService) {}

    /**
     * POST /api/v1/bulk-voucher-jobs/preview
     *
     * Returns the rich student list for Step 2 preview.
     * Each student has is_already_issued flag based on the date range.
     */
    @Post('preview')
    @HttpCode(HttpStatus.OK)
    async preview(@Body() dto: PreviewBulkRequestDto) {
        const students = await this.bulkVoucherJobsService.preview(dto);
        return {
            success: true,
            message: 'Preview generated successfully',
            data: students,
        };
    }

    /**
     * POST /api/v1/bulk-voucher-jobs
     *
     * Starts the bulk generation job. Returns immediately with job_id.
     * Frontend should poll GET /:id/status.
     */
    @Post()
    @HttpCode(HttpStatus.ACCEPTED)
    async startJob(@Body() dto: StartBulkJobDto, @Request() req: any) {
        // Use authenticated user id if available, otherwise fallback to 'system'
        const createdBy: string = req?.user?.id ?? req?.user?.sub ?? 'system';
        const result = await this.bulkVoucherJobsService.startJob(dto, createdBy);
        return {
            success: true,
            message: 'Bulk voucher job started',
            data: result,
        };
    }

    /**
     * GET /api/v1/bulk-voucher-jobs/:id/status
     *
     * Returns current job status + progress counters + merged_pdf_url.
     */
    @Get(':id/status')
    async getJobStatus(@Param('id', ParseIntPipe) id: number) {
        const job = await this.bulkVoucherJobsService.getJobStatus(id);
        return {
            success: true,
            message: 'Job status retrieved',
            data: job,
        };
    }

    /**
     * GET /api/v1/bulk-voucher-jobs
     *
     * Lists recent jobs (admin history view).
     */
    @Get()
    async listJobs(@Query('campus_id') campusId?: string) {
        const jobs = await this.bulkVoucherJobsService.listJobs(
            campusId ? parseInt(campusId, 10) : undefined,
        );
        return {
            success: true,
            message: 'Jobs retrieved',
            data: jobs,
        };
    }
}
