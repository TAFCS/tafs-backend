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
    UseGuards,
} from '@nestjs/common';
import { BulkVoucherJobsService } from './bulk-voucher-jobs.service';
import { PreviewBulkRequestDto } from './dto/preview-bulk-request.dto';
import { StartBulkJobDto } from './dto/start-bulk-job.dto';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { CurrentUser } from '../../decorators/current-user.decorator';
import { RequireAction } from '../../decorators/require-action.decorator';
import { Action } from '../auth/casl/actions';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';

// POST /vouchers/batch-issue (vouchers.controller.ts) ALSO calls
// bulkVoucherJobsService.startJob directly — decorated there with
// @RequireAnyAction across finance.bulk_voucher and finance.vouchers so
// neither tile's holders lock the other out. See tiles.manifest.ts.
@Controller('bulk-voucher-jobs')
export class BulkVoucherJobsController {
    constructor(private readonly bulkVoucherJobsService: BulkVoucherJobsService) {}

    /**
     * GET /api/v1/bulk-voucher-jobs/active
     *
     * Deploy safety check: returns whether any bulk voucher job is currently
     * in PROCESSING state. Publicly accessible so CI/CD and deployment scripts
     * can verify and wait before deploying or resizing containers.
     */
    @Get('active')
    @HttpCode(HttpStatus.OK)
    async getActiveJobs() {
        const result = await this.bulkVoucherJobsService.getActiveJobs();
        return {
            success: true,
            data: result,
        };
    }

    /**
     * POST /api/v1/bulk-voucher-jobs/preview
     *
     * Returns the rich student list for Step 2 preview.
     * Each student has is_already_issued flag based on the date range.
     */
    @Post('preview')
    @UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
    @HttpCode(HttpStatus.OK)
    @CheckPolicies(
        (ability) =>
            ability.can(Action.Create, 'Voucher') ||
            ability.can(Action.Manage, 'all'),
    )
    @RequireAction('finance.bulk_voucher#view')
    async preview(@Body() dto: PreviewBulkRequestDto, @CurrentUser() user: IJwtStaffPayload) {
        const students = await this.bulkVoucherJobsService.preview(dto, user);
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
    @UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
    @HttpCode(HttpStatus.ACCEPTED)
    @CheckPolicies(
        (ability) =>
            ability.can(Action.Create, 'Voucher') ||
            ability.can(Action.Manage, 'all'),
    )
    @RequireAction('finance.bulk_voucher#start')
    async startJob(
        @Body() dto: StartBulkJobDto,
        @CurrentUser() user: IJwtStaffPayload,
    ) {
        const createdBy = user.username ?? user.sub;
        const result = await this.bulkVoucherJobsService.startJob(
            dto,
            createdBy,
            user.fullName,
            user,
        );
        return {
            success: true,
            message: 'Bulk voucher job started',
            data: result,
        };
    }

    /**
     * POST /api/v1/bulk-voucher-jobs/:id/resume
     *
     * Resumes an interrupted job with identical settings and skip_already_issued: true,
     * so only unprocessed students get vouchers.
     */
    @Post(':id/resume')
    @UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
    @HttpCode(HttpStatus.ACCEPTED)
    @CheckPolicies(
        (ability) =>
            ability.can(Action.Create, 'Voucher') ||
            ability.can(Action.Manage, 'all'),
    )
    @RequireAction('finance.bulk_voucher#start')
    async resumeJob(
        @Param('id', ParseIntPipe) id: number,
        @CurrentUser() user: IJwtStaffPayload,
    ) {
        const result = await this.bulkVoucherJobsService.resumeJob(id, user);
        return {
            success: true,
            message: `Bulk voucher job #${id} resumed as job #${result.job_id}`,
            data: result,
        };
    }

    /**
     * GET /api/v1/bulk-voucher-jobs/:id/status
     *
     * Returns current job status + progress counters + phase + merged_pdf_url.
     */
    @Get(':id/status')
    @UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
    @CheckPolicies(
        (ability) =>
            ability.can(Action.Read, 'Voucher') ||
            ability.can(Action.Manage, 'all'),
    )
    @RequireAction('finance.bulk_voucher#view')
    async getJobStatus(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) {
        const job = await this.bulkVoucherJobsService.getJobStatus(id, user);
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
    @UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
    @CheckPolicies(
        (ability) =>
            ability.can(Action.Read, 'Voucher') ||
            ability.can(Action.Manage, 'all'),
    )
    @RequireAction('finance.bulk_voucher#view')
    async listJobs(@Query('campus_id') campusId: string | undefined, @CurrentUser() user: IJwtStaffPayload) {
        const campusIds = campusId
            ? campusId
                  .split(',')
                  .map((v) => parseInt(v.trim(), 10))
                  .filter((n) => Number.isInteger(n) && !Number.isNaN(n))
            : undefined;
        const jobs = await this.bulkVoucherJobsService.listJobs(
            campusIds?.length ? campusIds : undefined,
            user,
        );
        return {
            success: true,
            message: 'Jobs retrieved',
            data: jobs,
        };
    }
}
