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

    @Get('schedule')
    @CheckPolicies((ability) => ability.can(Action.Read, 'StudentFee'))
    async getStudentSchedule(
        @Query('studentId', ParseIntPipe) studentId: number,
        @Query('academicYear') academicYear: string,
        @Query('classId', ParseIntPipe) classId: number,
        @Query('campusId') campusId?: string,
    ) {
        const data = await this.studentFeesService.getStudentSchedule(
            studentId,
            academicYear,
            classId,
            campusId ? Number(campusId) : undefined,
        );
        return {
            success: true,
            message: 'Student schedule retrieved successfully',
            data,
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
        return { success: true, message: 'Bundles retrieved successfully', data: bundles };
    }

    // ─── Bulk Operations ──────────────────────────────────────────────────────

    @Get('bulk-preview')
    @CheckPolicies((ability) => ability.can(Action.Read, 'StudentFee') || ability.can(Action.Manage, 'all'))
    async bulkPreview(
        @Query('campus_id', ParseIntPipe) campus_id: number,
        @Query('academic_year') academic_year: string,
        @Query('fee_type_id', ParseIntPipe) fee_type_id: number,
        @Query('fee_date') fee_date: string,
        @Query('class_id') class_id?: string,
        @Query('section_id') section_id?: string,
    ) {
        const data = await this.studentFeesService.bulkPreview({
            campus_id,
            academic_year,
            fee_type_id,
            fee_date,
            class_id: class_id ? Number(class_id) : undefined,
            section_id: section_id ? Number(section_id) : undefined,
        });
        return { success: true, data };
    }

    @Post('bulk-add')
    @HttpCode(HttpStatus.OK)
    @CheckPolicies((ability) => ability.can(Action.Create, 'StudentFee') || ability.can(Action.Manage, 'all'))
    async bulkAdd(@Body() dto: any) {
        const data = await this.studentFeesService.bulkAdd(dto);
        return { success: true, data };
    }

    @Get('bulk-add-range-conflicts')
    @CheckPolicies((ability) => ability.can(Action.Read, 'StudentFee') || ability.can(Action.Manage, 'all'))
    async bulkAddRangeConflicts(
        @Query('campus_id', ParseIntPipe) campus_id: number,
        @Query('academic_year') academic_year: string,
        @Query('fee_type_id', ParseIntPipe) fee_type_id: number,
        @Query('start_month', ParseIntPipe) start_month: number,
        @Query('end_month', ParseIntPipe) end_month: number,
        @Query('day', ParseIntPipe) day: number,
        @Query('class_id') class_id?: string,
        @Query('section_id') section_id?: string,
    ) {
        const data = await this.studentFeesService.bulkAddRangeConflicts({
            campus_id, academic_year, fee_type_id, start_month, end_month, day,
            class_id: class_id ? Number(class_id) : undefined,
            section_id: section_id ? Number(section_id) : undefined,
        });
        return { success: true, data };
    }

    @Post('bulk-add-range')
    @HttpCode(HttpStatus.OK)
    @CheckPolicies((ability) => ability.can(Action.Create, 'StudentFee') || ability.can(Action.Manage, 'all'))
    async bulkAddRange(@Body() dto: any) {
        const data = await this.studentFeesService.bulkAddRange(dto);
        return { success: true, data };
    }

    @Get('bulk-delete-preview')
    @CheckPolicies((ability) => ability.can(Action.Read, 'StudentFee') || ability.can(Action.Manage, 'all'))
    async bulkDeletePreview(
        @Query('campus_id', ParseIntPipe) campus_id: number,
        @Query('academic_year') academic_year: string,
        @Query('fee_date') fee_date: string,
        @Query('class_id') class_id?: string,
        @Query('section_id') section_id?: string,
        @Query('fee_type_id') fee_type_id?: string,
    ) {
        const data = await this.studentFeesService.bulkDeletePreview({
            campus_id, academic_year, fee_date,
            class_id: class_id ? Number(class_id) : undefined,
            section_id: section_id ? Number(section_id) : undefined,
            fee_type_id: fee_type_id ? Number(fee_type_id) : undefined,
        });
        return { success: true, data };
    }

    @Get('bulk-delete-range-preview')
    @CheckPolicies((ability) => ability.can(Action.Read, 'StudentFee') || ability.can(Action.Manage, 'all'))
    async bulkDeleteRangePreview(
        @Query('campus_id', ParseIntPipe) campus_id: number,
        @Query('academic_year') academic_year: string,
        @Query('start_month', ParseIntPipe) start_month: number,
        @Query('end_month', ParseIntPipe) end_month: number,
        @Query('day', ParseIntPipe) day: number,
        @Query('class_id') class_id?: string,
        @Query('section_id') section_id?: string,
        @Query('fee_type_id') fee_type_id?: string,
    ) {
        const data = await this.studentFeesService.bulkDeleteRangePreview({
            campus_id, academic_year, start_month, end_month, day,
            class_id: class_id ? Number(class_id) : undefined,
            section_id: section_id ? Number(section_id) : undefined,
            fee_type_id: fee_type_id ? Number(fee_type_id) : undefined,
        });
        return { success: true, data };
    }

    @Delete('bulk-delete')
    @HttpCode(HttpStatus.OK)
    @CheckPolicies((ability) => ability.can(Action.Delete, 'StudentFee') || ability.can(Action.Manage, 'all'))
    async bulkDelete(@Body() dto: any) {
        const data = await this.studentFeesService.bulkDelete(dto);
        return { success: true, data };
    }
}
