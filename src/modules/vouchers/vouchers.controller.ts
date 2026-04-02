import {
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
    UploadedFile,
    UseGuards,
    UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { VouchersService } from './vouchers.service';
import { CreateVoucherDto } from './dto/create-voucher.dto';
import { CreateBulkVouchersDto } from './dto/create-bulk-vouchers.dto';
import { PreviewBulkVouchersDto } from './dto/preview-bulk-vouchers.dto';
import { UpdateVoucherDto } from './dto/update-voucher.dto';
import { FilterVouchersDto } from './dto/filter-vouchers.dto';
import { RecordVoucherDepositDto } from './dto/record-voucher-deposit.dto';
import { SplitPartiallyPaidDto } from './dto/split-partially-paid.dto';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';

@Controller('vouchers')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class VouchersController {
    constructor(private readonly vouchersService: VouchersService) {}

    @Post()
    @HttpCode(HttpStatus.CREATED)
    @CheckPolicies(
        (ability) =>
            ability.can(Action.Create, 'Voucher') ||
            ability.can(Action.Manage, 'all'),
    )
    @UseInterceptors(FileInterceptor('pdf'))
    async create(
        @Body() dto: CreateVoucherDto,
        @UploadedFile() pdf?: Express.Multer.File,
    ) {
        const voucher = await this.vouchersService.create(dto, pdf?.buffer);
        return {
            success: true,
            message: 'Voucher created successfully',
            data: voucher,
        };
    }

    @Post('bulk/preview')
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
    @HttpCode(HttpStatus.CREATED)
    @CheckPolicies(
        (ability) =>
            ability.can(Action.Create, 'Voucher') ||
            ability.can(Action.Manage, 'all'),
    )
    async createBulk(@Body() dto: CreateBulkVouchersDto) {
        const result = await this.vouchersService.createBulk(dto);
        return {
            success: true,
            message: 'Bulk vouchers created successfully',
            data: result,
        };
    }

    @Get()
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
        );
        return {
            success: true,
            message: 'Vouchers retrieved successfully',
            data: vouchers,
        };
    }

    @Get('by-student/:cc')
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

    @Post(':id/deposit')
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

    /** Split a PARTIALLY_PAID voucher: create a new UNPAID voucher for the outstanding balances. */
    @Post(':id/split-partially-paid')
    @HttpCode(HttpStatus.CREATED)
    @CheckPolicies(
        (ability) =>
            ability.can(Action.Create, 'Voucher') ||
            ability.can(Action.Manage, 'all'),
    )
    @UseInterceptors(FileInterceptor('pdf'))
    async splitPartiallyPaid(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: SplitPartiallyPaidDto,
        @UploadedFile() pdf?: Express.Multer.File,
    ) {
        const voucher = await this.vouchersService.splitPartiallyPaid(id, dto, pdf?.buffer);
        return {
            success: true,
            message: 'New unpaid voucher created for outstanding balance.',
            data: voucher,
        };
    }
}
