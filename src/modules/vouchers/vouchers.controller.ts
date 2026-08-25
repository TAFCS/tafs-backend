import {
    BadRequestException,
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseIntPipe,
    Patch,
    Post,
    Query,
    Req,
    UploadedFile,
    UploadedFiles,
    UseGuards,
    UseInterceptors,
    Delete,
    Inject,
    forwardRef,
    Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { FileFieldsInterceptor, FileInterceptor } from '@nestjs/platform-express';
import { VouchersService } from './vouchers.service';
import { CreateVoucherDto } from './dto/create-voucher.dto';
import { UpdateVoucherDto } from './dto/update-voucher.dto';
import { FilterVouchersDto } from './dto/filter-vouchers.dto';
import { RecordVoucherDepositDto } from './dto/record-voucher-deposit.dto';
import { ClearDepositDto } from './dto/clear-deposit.dto';
import { SplitPartiallyPaidDto } from './dto/split-partially-paid.dto';
import { GenerateVoucherPdfDto } from './dto/generate-voucher-pdf.dto';
import { BulkDeleteVouchersDto } from './dto/bulk-delete-vouchers.dto';
import { BatchPreviewDto } from './dto/batch-preview.dto';
import { StartBulkJobDto } from '../bulk-voucher-jobs/dto/start-bulk-job.dto';
import { BulkVoucherJobsService } from '../bulk-voucher-jobs/bulk-voucher-jobs.service';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { JwtParentGuard } from '../../common/guards/jwt-parent.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';

@Controller('vouchers')
export class VouchersController {
    constructor(
        private readonly vouchersService: VouchersService,
        @Inject(forwardRef(() => BulkVoucherJobsService))
        private readonly bulkJobsService: BulkVoucherJobsService,
    ) {}

    @Post()
    @UseGuards(JwtStaffGuard, PoliciesGuard)
    @HttpCode(HttpStatus.CREATED)
    @CheckPolicies(
        (ability) =>
            ability.can(Action.Create, 'Voucher') ||
            ability.can(Action.Manage, 'all'),
    )
    @UseInterceptors(FileInterceptor('pdf'))
    async create(
        @Body() dto: CreateVoucherDto,
        @Req() req: any,
        @UploadedFile() pdf?: Express.Multer.File,
    ) {
        if (dto.waive_surcharge && !dto.waived_by) {
            dto.waived_by = req.user?.username || req.user?.id || 'Unknown';
        }
        const changedBy = req.user?.username || req.user?.id || 'system';
        const voucher = await this.vouchersService.create(dto, pdf?.buffer, changedBy);
        return {
            success: true,
            message: 'Voucher created successfully',
            data: voucher,
        };
    }

    /** Compute arrears for a student before a given fee_date. */
    @Get('arrears')
    @UseGuards(JwtStaffGuard, PoliciesGuard)
    @CheckPolicies(
        (ability) =>
            ability.can(Action.Read, 'Voucher') ||
            ability.can(Action.Manage, 'all'),
    )
    async getArrears(
        @Query('student_id') studentIdStr: string,
        @Query('fee_date') feeDateStr: string,
        @Query('waive_surcharge') waiveSurchargeStr?: string,
    ) {
        const studentId = parseInt(studentIdStr, 10);
        const feeDate = new Date(feeDateStr);
        const waiveSurcharge = waiveSurchargeStr === 'true';

        const result = await this.vouchersService.computeArrears(studentId, feeDate, waiveSurcharge);
        return {
            success: true,
            message: 'Arrears computed successfully',
            data: result,
        };
    }

    @Get()
    @UseGuards(JwtStaffGuard, PoliciesGuard)
    @CheckPolicies(
        (ability) =>
            ability.can(Action.Read, 'Voucher') ||
            ability.can(Action.Manage, 'all'),
    )
    async findAll(@Query() query: FilterVouchersDto) {
        const vouchers = await this.vouchersService.findAll(
            query.student_id,
            query.campus_id,
            query.status,
            query.class_id,
            query.section_id,
            query.cc,
            query.gr,
            query.id,
            query.date_from,
            query.date_to,
            query.page,
            query.limit,
            query.single_fee_date,
            query.multiple_fee_heads,
            query.class_scope,
            query.student_status,
            query.graduated_from_class_id,
            query.graduated_year_range,
        );
        return {
            success: true,
            message: 'Vouchers retrieved successfully',
            data: vouchers,
        };
    }

    @Get('by-student/:cc')
    @UseGuards(JwtStaffGuard, PoliciesGuard)
    @CheckPolicies(
        (ability) =>
            ability.can(Action.Read, 'Voucher') ||
            ability.can(Action.Manage, 'all'),
    )
    async findByStudent(@Param('cc', ParseIntPipe) cc: number) {
        const vouchers = await this.vouchersService.findByStudentCC(cc);
        return {
            success: true,
            message: 'Student vouchers retrieved successfully',
            data: vouchers,
        };
    }

    @Get(':id')
    @UseGuards(JwtStaffGuard, PoliciesGuard)
    @CheckPolicies(
        (ability) =>
            ability.can(Action.Read, 'Voucher') ||
            ability.can(Action.Manage, 'all'),
    )
    async findOne(@Param('id', ParseIntPipe) id: number) {
        const voucher = await this.vouchersService.findOne(id);
        return {
            success: true,
            message: 'Voucher retrieved successfully',
            data: voucher,
        };
    }

    /** Generate (or regenerate) the voucher PDF server-side, store it, and return the URL. */
    @Post(':id/generate-pdf')
    @UseGuards(JwtStaffGuard, PoliciesGuard)
    @HttpCode(HttpStatus.OK)
    @CheckPolicies(
        (ability) =>
            ability.can(Action.Update, 'Voucher') ||
            ability.can(Action.Manage, 'all'),
    )
    async generatePdf(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: GenerateVoucherPdfDto,
        @Req() req: any,
    ) {
        const generatedByName = await this.vouchersService.resolveGeneratedByName(req?.user?.id ?? req?.user?.sub);
        const result = await this.vouchersService.generatePdf(
            id,
            dto.show_discount ?? true,
            dto.paid_stamp ?? false,
            generatedByName,
        );
        return {
            success: true,
            message: 'Voucher PDF generated successfully',
            data: result,
        };
    }

    /**
     * SPECIAL ADMIN WORKFLOW — see VouchersService.generateMainColumnReceipt()
     * for full context and the removal checklist. Only valid for a PAID
     * voucher produced by splitPartiallyPaid() whose heads are all old
     * (arrear) heads; everything else 400s with a specific reason.
     */
    @Post(':id/generate-main-column-receipt')
    @UseGuards(JwtStaffGuard, PoliciesGuard)
    @HttpCode(HttpStatus.OK)
    @CheckPolicies(
        (ability) =>
            ability.can(Action.Update, 'Voucher') ||
            ability.can(Action.Manage, 'all'),
    )
    async generateMainColumnReceipt(
        @Param('id', ParseIntPipe) id: number,
        @Req() req: any,
    ) {
        const changedBy = req.user?.username || req.user?.id || 'system';
        const result = await this.vouchersService.generateMainColumnReceipt(id, changedBy);
        return {
            success: true,
            message: 'Main-column receipt generated successfully.',
            data: result,
        };
    }

    @Post(':id/deposit')
    @UseGuards(JwtStaffGuard, PoliciesGuard)
    @HttpCode(HttpStatus.OK)
    @CheckPolicies(
        (ability) =>
            ability.can(Action.Update, 'Voucher') ||
            ability.can(Action.Manage, 'all'),
    )
    async recordDeposit(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: RecordVoucherDepositDto,
        @Req() req: any,
    ) {
        const changedBy = req.user?.username || req.user?.id || 'system';
        const voucher = await this.vouchersService.recordDeposit(id, dto, changedBy);
        return {
            success: true,
            message: 'Voucher deposit recorded successfully',
            data: voucher,
        };
    }

    @Post(':id/clear-deposit')
    @UseGuards(JwtStaffGuard, PoliciesGuard)
    @HttpCode(HttpStatus.OK)
    @CheckPolicies(
        (ability) =>
            ability.can(Action.Update, 'Voucher') ||
            ability.can(Action.Manage, 'all'),
    )
    async clearDeposit(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: ClearDepositDto,
        @Req() req: any,
    ) {
        const changedBy = req.user?.username || req.user?.id || 'system';
        const voucher = await this.vouchersService.clearDeposit(id, dto.depositId, changedBy);
        return {
            success: true,
            message: voucher === null
                ? 'Deposit cleared and PAID voucher deleted — fee heads reset to Not Issued.'
                : 'Deposit cleared successfully and allocations reversed',
            data: voucher,
            deleted: voucher === null,
        };
    }

    @Patch(':id')
    @UseGuards(JwtStaffGuard, PoliciesGuard)
    @CheckPolicies(
        (ability) =>
            ability.can(Action.Update, 'Voucher') ||
            ability.can(Action.Manage, 'all'),
    )
    async update(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: UpdateVoucherDto,
        @Req() req: any,
    ) {
        const changedBy = req.user?.username || req.user?.id || 'system';
        const voucher = await this.vouchersService.update(id, dto, changedBy);
        return {
            success: true,
            message: 'Voucher updated successfully',
            data: voucher,
        };
    }

    /**
     * Split a PARTIALLY_PAID voucher into a new PAID voucher + a new UNPAID balance voucher.
     * Per fee head: PARTIALLY_PAID student_fees rows are split into paid + balance rows; PAID/ISSUED
     * rows are re-linked without renaming. The original voucher is VOID; deposit_allocations stay on
     * the original voucher_id (Case A updates student_fee_id to the new paid fee row).
     */
    @Post(':id/split-partially-paid')
    @UseGuards(JwtStaffGuard, PoliciesGuard)
    @HttpCode(HttpStatus.CREATED)
    @CheckPolicies(
        (ability) =>
            ability.can(Action.Create, 'Voucher') ||
            ability.can(Action.Manage, 'all'),
    )
    async splitPartiallyPaid(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: SplitPartiallyPaidDto,
        @Req() req: any,
    ) {
        const changedBy = req.user?.username || req.user?.id || 'system';
        const result = await this.vouchersService.splitPartiallyPaid(id, dto, changedBy);
        return {
            success: true,
            message: 'Voucher split into paid and unpaid records successfully.',
            data: result,
        };
    }

    // --- Parent Facing ---

    @Get('parent/student/:cc')
    @UseGuards(JwtParentGuard)
    @HttpCode(HttpStatus.OK)
    async findByStudentForParent(
        @Param('cc', ParseIntPipe) cc: number,
        @Req() req: any,
    ) {
        const familyId = req.user.familyId;
        // Verify family access (usually inside service)
        const vouchers = await this.vouchersService.findByStudentCC(cc, familyId);
        return {
            success: true,
            message: 'Vouchers retrieved successfully',
            data: vouchers,
        };
    }

    /**
     * Lazily mint (first call) or return (every call after) the frozen PAID
     * receipt for one voucher. POST because the first call has a side effect —
     * it renders and uploads a PDF and freezes its filename forever.
     */
    @Post('parent/student/:cc/voucher/:id/paid-pdf')
    @UseGuards(JwtParentGuard)
    @HttpCode(HttpStatus.OK)
    async ensurePaidPdfForParent(
        @Param('cc', ParseIntPipe) cc: number,
        @Param('id', ParseIntPipe) id: number,
        @Req() req: any,
    ) {
        const result = await this.vouchersService.ensurePaidPdfForParent(
            id,
            cc,
            req.user.familyId,
        );
        return {
            success: true,
            message: 'Paid challan ready.',
            data: result,
        };
    }

    @Get('parent/student/:cc/resolve')
    @UseGuards(JwtParentGuard)
    @HttpCode(HttpStatus.OK)
    async resolveVoucherForParentByMonth(
        @Param('cc', ParseIntPipe) cc: number,
        @Query('academic_year') academicYear: string,
        @Query('target_month') targetMonth: string,
        @Req() req: any,
    ) {
        const parsedTargetMonth = Number(targetMonth);
        if (!academicYear || Number.isNaN(parsedTargetMonth)) {
            throw new BadRequestException(
                'academic_year and target_month query parameters are required.',
            );
        }

        if (parsedTargetMonth < 1 || parsedTargetMonth > 12) {
            throw new BadRequestException(
                'target_month must be between 1 and 12.',
            );
        }

        const familyId = req.user.familyId;
        const result = await this.vouchersService.resolveVoucherForParentByMonth(
            cc,
            familyId,
            academicYear,
            parsedTargetMonth,
        );

        return {
            success: true,
            message: 'Voucher resolution completed',
            data: result,
        };
    }

    @Post('batch-preview')
    @UseGuards(JwtStaffGuard, PoliciesGuard)
    @HttpCode(HttpStatus.OK)
    @CheckPolicies((ability) => ability.can(Action.Read, 'Voucher') || ability.can(Action.Manage, 'all'))
    async batchPreview(@Body() dto: BatchPreviewDto) {
        const data = await this.vouchersService.batchPreview(dto);
        return {
            success: true,
            message: 'Batch preview generated successfully',
            data,
        };
    }

    @Post('batch-export')
    @UseGuards(JwtStaffGuard, PoliciesGuard)
    @CheckPolicies((ability) => ability.can(Action.Read, 'Voucher') || ability.can(Action.Manage, 'all'))
    async batchExport(@Body() dto: { ids: number[] }, @Res() res: Response, @Req() req: any) {
        const generatedByName = await this.vouchersService.resolveGeneratedByName(req?.user?.id ?? req?.user?.sub);
        const buffer = await this.vouchersService.batchExport(dto.ids, generatedByName);
        res.set({
            'Content-Type': 'application/zip',
            'Content-Disposition': 'attachment; filename=vouchers_batch.zip',
            'Content-Length': buffer.length,
        });
        res.send(buffer);
    }

    @Post('batch-merge')
    @UseGuards(JwtStaffGuard, PoliciesGuard)
    @CheckPolicies((ability) => ability.can(Action.Read, 'Voucher') || ability.can(Action.Manage, 'all'))
    async batchMerge(@Body() dto: { ids: number[] }, @Res() res: Response, @Req() req: any) {
        const generatedByName = await this.vouchersService.resolveGeneratedByName(req?.user?.id ?? req?.user?.sub);
        const buffer = await this.vouchersService.batchMerge(dto.ids, generatedByName);
        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': 'attachment; filename=vouchers_merged.pdf',
            'Content-Length': buffer.length,
        });
        res.send(buffer);
    }

    @Post('batch-issue')
    @UseGuards(JwtStaffGuard, PoliciesGuard)
    @HttpCode(HttpStatus.ACCEPTED)
    @CheckPolicies((ability) => ability.can(Action.Create, 'Voucher') || ability.can(Action.Manage, 'all'))
    async batchIssue(@Body() dto: StartBulkJobDto, @Req() req: any) {
        const createdBy: string = req?.user?.username ?? req?.user?.sub ?? 'system';
        const result = await this.bulkJobsService.startJob(
            dto,
            createdBy,
            req?.user?.fullName,
        );
        return {
            success: true,
            message: 'Batch generation job started',
            data: result,
        };
    }

    @Delete('bulk')
    @UseGuards(JwtStaffGuard, PoliciesGuard)
    @CheckPolicies((ability) => ability.can(Action.Delete, 'Voucher') || ability.can(Action.Manage, 'all'))
    async bulkRemove(@Body() dto: BulkDeleteVouchersDto, @Req() req: any) {
        const changedBy = req.user?.username || req.user?.id || 'system';
        const results = await this.vouchersService.bulkRemove(dto.ids, dto.force ?? false, changedBy);
        return {
            success: true,
            message: `${results.deleted} deleted, ${results.skipped} skipped.`,
            data: results,
        };
    }

    @Delete(':id')
    @UseGuards(JwtStaffGuard, PoliciesGuard)
    @CheckPolicies(
        (ability) =>
            ability.can(Action.Delete, 'Voucher') ||
            ability.can(Action.Manage, 'all'),
    )
    async remove(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
        const changedBy = req.user?.username || req.user?.id || 'system';
        const result = await this.vouchersService.remove(id, changedBy);
        return {
            success: true,
            message: 'Voucher deleted and fee heads reset successfully.',
            data: result,
        };
    }
}
