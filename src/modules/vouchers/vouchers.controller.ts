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
    UseGuards,
} from '@nestjs/common';
import { VouchersService } from './vouchers.service';
import { CreateVoucherDto } from './dto/create-voucher.dto';
import { UpdateVoucherDto } from './dto/update-voucher.dto';
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
    async create(@Body() dto: CreateVoucherDto) {
        const voucher = await this.vouchersService.create(dto);
        return {
            success: true,
            message: 'Voucher created successfully',
            data: voucher,
        };
    }

    @Get()
    @CheckPolicies(
        (ability) =>
            ability.can(Action.Read, 'Voucher') ||
            ability.can(Action.Manage, 'all'),
    )
    async findAll(
        @Query('student_id') studentId?: string,
        @Query('campus_id') campusId?: string,
        @Query('status') status?: string,
    ) {
        const vouchers = await this.vouchersService.findAll(
            studentId ? parseInt(studentId) : undefined,
            campusId ? parseInt(campusId) : undefined,
            status,
        );
        return {
            success: true,
            message: 'Vouchers retrieved successfully',
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
}
