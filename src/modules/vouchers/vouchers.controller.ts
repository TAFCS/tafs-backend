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
} from '@nestjs/common';
import { FileFieldsInterceptor, FileInterceptor } from '@nestjs/platform-express';
import { VouchersService } from './vouchers.service';
import { CreateVoucherDto } from './dto/create-voucher.dto';
import { CreateBulkVouchersDto } from './dto/create-bulk-vouchers.dto';
import { PreviewBulkVouchersDto } from './dto/preview-bulk-vouchers.dto';
import { UpdateVoucherDto } from './dto/update-voucher.dto';
import { FilterVouchersDto } from './dto/filter-vouchers.dto';
import { RecordVoucherDepositDto } from './dto/record-voucher-deposit.dto';
import { SplitPartiallyPaidDto } from './dto/split-partially-paid.dto';
import { GenerateVoucherPdfDto } from './dto/generate-voucher-pdf.dto';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { JwtParentGuard } from '../../common/guards/jwt-parent.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';

@Controller('vouchers')
export class VouchersController {
    constructor(private readonly vouchersService: VouchersService) {}

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
        const voucher = await this.vouchersService.create(dto, pdf?.buffer);
        return {
            success: true,
            message: 'Voucher created successfully',
            data: voucher,
        };
    }

    @Post('bulk/preview')
    @UseGuards(JwtStaffGuard, PoliciesGuard)
    @HttpCode(HttpStatus.OK)
    @CheckPolicies(
        (ability) =>
            ability.can(Action.Create, 'Voucher') ||
            ability.can(Action.Manage, 'all'),
    )
    async previewBulk(@Body() dto: PreviewBulkVouchersDto) {
        const preview = await this.vouchersService.previewBulk(dto);
        return {
            success: true,
            message: 'Bulk voucher preview generated successfully',
            data: preview,
        };
    }

    @Post('bulk/create')
    @UseGuards(JwtStaffGuard, PoliciesGuard)
    @HttpCode(HttpStatus.CREATED)
    @CheckPolicies(
        (ability) =>
            ability.can(Action.Create, 'Voucher') ||
            ability.can(Action.Manage, 'all'),
    )
    async createBulk(@Body() dto: CreateBulkVouchersDto, @Req() req: any) {
        if (dto.waive_surcharge && !dto.waived_by) {
            dto.waived_by = req.user?.username || req.user?.id || 'Unknown';
        }
        const result = await this.vouchersService.createBulk(dto);
        return {
            success: true,
            message: 'Bulk vouchers created successfully',
            data: result,
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
        
        const result = await this.vouchersService.computeArrears(studentId, feeDate, waiveSurcharge, false);
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
    ) {
        const result = await this.vouchersService.generatePdf(
            id,
            dto.show_discount ?? true,
            dto.paid_stamp ?? false,
        );
        return {
            success: true,
            message: 'Voucher PDF generated successfully',
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
    ) {
        const voucher = await this.vouchersService.recordDeposit(id, dto);
        return {
            success: true,
            message: 'Voucher deposit recorded successfully',
            data: voucher,
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
    ) {
        const voucher = await this.vouchersService.update(id, dto);
        return {
            success: true,
            message: 'Voucher updated successfully',
            data: voucher,
        };
    }

    /** Save a stamped PAID PDF back to the voucher record. */
    @Patch(':id/paid-pdf')
    @UseGuards(JwtStaffGuard, PoliciesGuard)
    @HttpCode(HttpStatus.OK)
    @CheckPolicies(
        (ability) =>
            ability.can(Action.Update, 'Voucher') ||
            ability.can(Action.Manage, 'all'),
    )
    @UseInterceptors(FileInterceptor('pdf'))
    async savePaidPdf(
        @Param('id', ParseIntPipe) id: number,
        @UploadedFile() pdf: Express.Multer.File,
    ) {
        if (!pdf?.buffer) {
            return { success: false, message: 'No PDF file uploaded.' };
        }
        const result = await this.vouchersService.savePaidPdf(id, pdf.buffer);
        return { success: true, message: 'Paid PDF saved.', data: result };
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
    ) {
        const result = await this.vouchersService.splitPartiallyPaid(id, dto);
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
}
