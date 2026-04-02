import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    Post,
    Query,
    Patch,
    Delete,
    ParseIntPipe,
    UseGuards,
} from '@nestjs/common';
import { StudentFeesService } from './student-fees.service';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';
import { BulkSaveStudentFeesDto } from './dto/bulk-save-student-fees.dto';

@Controller('student-fees')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class StudentFeesController {
    constructor(private readonly studentFeesService: StudentFeesService) { }

    @Get('by-student/:ccNumber')
    @CheckPolicies(
        (ability) =>
            ability.can(Action.Read, 'StudentFee') ||
            ability.can(Action.Manage, 'all'),
    )
    async findByStudentCC(
        @Param('ccNumber') ccNumber: string,
        @Query('dateFrom') dateFrom?: string,
        @Query('dateTo') dateTo?: string,
    ) {
        const fees = await this.studentFeesService.findByStudentCC(ccNumber, dateFrom, dateTo);
        return {
            success: true,
            message: 'Student fees retrieved successfully',
            data: fees,
        };
    }


    @Post('bulk')
    @HttpCode(HttpStatus.OK)
    @CheckPolicies(
        (ability) =>
            ability.can(Action.Create, 'StudentFee') ||
            ability.can(Action.Update, 'StudentFee') ||
            ability.can(Action.Manage, 'all'),
    )
    async bulkSave(@Body() dto: BulkSaveStudentFeesDto) {
        const updated = await this.studentFeesService.bulkSave(dto);
        return {
            success: true,
            message: 'Student fees saved successfully',
            data: updated,
        };
    }

    /**
     * Explicitly update fee_date for a batch of student_fees records by ID.
     * Used to persist manual date changes before bundle creation.
     */
    @Patch('update-fee-dates')
    @HttpCode(HttpStatus.OK)
    @CheckPolicies(
        (ability) =>
            ability.can(Action.Update, 'StudentFee') ||
            ability.can(Action.Manage, 'all'),
    )
    async updateFeeDates(@Body() body: { updates: { id: number; fee_date: string }[] }) {
        const updated = await this.studentFeesService.updateFeeDates(body.updates);
        return {
            success: true,
            message: 'Fee dates updated successfully',
            data: updated,
        };
    }

    @Post('bundles')
    @CheckPolicies((ability) => ability.can(Action.Create, 'StudentFee'))
    async createBundle(@Body() dto: any) {
        const bundle = await this.studentFeesService.createBundle(dto);
        return {
            success: true,
            message: 'Bundle created successfully',
            data: bundle,
        };
    }

    @Patch('bundles/:id')
    @CheckPolicies((ability) => ability.can(Action.Update, 'StudentFee'))
    async updateBundle(@Param('id', ParseIntPipe) id: number, @Body() dto: any) {
        const bundle = await this.studentFeesService.updateBundle(id, dto);
        return {
            success: true,
            message: 'Bundle updated successfully',
            data: bundle,
        };
    }

    @Delete('bundles/:id')
    @CheckPolicies((ability) => ability.can(Action.Delete, 'StudentFee'))
    async deleteBundle(@Param('id', ParseIntPipe) id: number) {
        await this.studentFeesService.deleteBundle(id);
        return {
            success: true,
            message: 'Bundle deleted successfully',
        };
    }

    @Get('bundles/:studentId')
    @CheckPolicies((ability) => ability.can(Action.Read, 'StudentFee'))
    async getBundlesByStudent(@Param('studentId', ParseIntPipe) studentId: number) {
        const bundles = await this.studentFeesService.getBundlesByStudent(studentId);
        return {
            success: true,
            message: 'Bundles retrieved successfully',
            data: bundles,
        };
    }
}
