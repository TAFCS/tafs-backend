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
    Req,
    UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { StudentFeesService } from './student-fees.service';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { RequireAction } from '../../decorators/require-action.decorator';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { Action } from '../auth/casl/actions';
import { BulkSaveStudentFeesDto } from './dto/bulk-save-student-fees.dto';
import { CreateDiscountDto } from './dto/create-discount.dto';
import { ApplyScholarshipDto } from './dto/apply-scholarship.dto';
import { TransferHeadsDto } from './dto/transfer-heads.dto';
import { WaiveHeadsDto, UnwaiveHeadsDto } from './dto/waive-heads.dto';

/**
 * Sub-permissions live on the `finance.student_overrides` tile
 * (tiles.manifest.ts). TileActionGuard sits ALONGSIDE PoliciesGuard: CASL keeps
 * guarding the coarse capability, @RequireAction adds the fine one, both must
 * pass.
 *
 * `GET /by-student/:ccNumber` is deliberately left undecorated -- the Single
 * Voucher Issuance page (tile `finance.single_voucher`) reads it too, and
 * pinning it to this tile's `view` would 403 every voucher clerk who does not
 * also hold Student Overrides. It stays on its CASL check until vouchers get
 * their own actions.
 */
@Controller('student-fees')
@UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
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
        @CurrentUser() user: IJwtStaffPayload,
        @Query('dateFrom') dateFrom?: string,
        @Query('dateTo') dateTo?: string,
    ) {
        const fees = await this.studentFeesService.findByStudentCC(ccNumber, user, dateFrom, dateTo);
        return {
            success: true,
            message: 'Student fees retrieved successfully',
            data: fees,
        };
    }

    @Get('schedule')
    @CheckPolicies((ability) => ability.can(Action.Read, 'StudentFee'))
    @RequireAction('finance.student_overrides#view')
    async getStudentSchedule(
        @Query('studentId', ParseIntPipe) studentId: number,
        @Query('academicYear') academicYear: string,
        @CurrentUser() user: IJwtStaffPayload,
        @Query('classId') classId?: string,
        @Query('campusId') campusId?: string,
    ) {
        const data = await this.studentFeesService.getStudentSchedule(
            studentId,
            academicYear,
            user,
            classId ? Number(classId) : undefined,
            campusId ? Number(campusId) : undefined,
        );
        return {
            success: true,
            message: 'Student schedule retrieved successfully',
            data,
        };
    }

    @Get('student/:studentId/schedule')
    @CheckPolicies((ability) => ability.can(Action.Read, 'StudentFee'))
    @RequireAction('finance.student_overrides#view')
    async getStudentScheduleAlt(
        @Param('studentId', ParseIntPipe) studentId: number,
        @Query('academic_year') academicYear: string,
        @CurrentUser() user: IJwtStaffPayload,
    ) {
        const data = await this.studentFeesService.getStudentSchedule(
            studentId,
            academicYear,
            user,
        );
        return {
            success: true,
            message: 'Student schedule retrieved successfully',
            data,
        };
    }


    @Get('caution-fee-history/:studentId')
    @CheckPolicies((ability) => ability.can(Action.Read, 'StudentFee'))
    @RequireAction('finance.student_overrides#view')
    async getCautionFeeHistory(@Param('studentId', ParseIntPipe) studentId: number, @CurrentUser() user: IJwtStaffPayload) {
        const data = await this.studentFeesService.getCautionFeeHistory(studentId, user);
        return { success: true, data };
    }

    @Post('bulk')
    @HttpCode(HttpStatus.OK)
    @CheckPolicies(
        (ability) =>
            ability.can(Action.Create, 'StudentFee') ||
            ability.can(Action.Update, 'StudentFee') ||
            ability.can(Action.Manage, 'all'),
    )
    @RequireAction('finance.student_overrides#schedule.edit')
    async bulkSave(@Body() dto: BulkSaveStudentFeesDto, @Req() req: Request, @CurrentUser() user: IJwtStaffPayload) {
        const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
        const updated = await this.studentFeesService.bulkSave(dto, user, changedBy);
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
    @RequireAction('finance.student_overrides#schedule.edit')
    async updateFeeDates(@Body() body: { updates: { id: number; fee_date: string }[] }, @Req() req: Request, @CurrentUser() user: IJwtStaffPayload) {
        const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
        const updated = await this.studentFeesService.updateFeeDates(body.updates, user, changedBy);
        return {
            success: true,
            message: 'Fee dates updated successfully',
            data: updated,
        };
    }

    @Post('bundles')
    @CheckPolicies((ability) => ability.can(Action.Create, 'StudentFee'))
    @RequireAction('finance.student_overrides#bundle.manage')
    async createBundle(@Body() dto: any, @Req() req: Request, @CurrentUser() user: IJwtStaffPayload) {
        const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
        const bundle = await this.studentFeesService.createBundle(dto, user, changedBy);
        return {
            success: true,
            message: 'Bundle created successfully',
            data: bundle,
        };
    }

    @Patch('bundles/:id')
    @CheckPolicies((ability) => ability.can(Action.Update, 'StudentFee'))
    @RequireAction('finance.student_overrides#bundle.manage')
    async updateBundle(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @Req() req: Request, @CurrentUser() user: IJwtStaffPayload) {
        const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
        const bundle = await this.studentFeesService.updateBundle(id, dto, user, changedBy);
        return {
            success: true,
            message: 'Bundle updated successfully',
            data: bundle,
        };
    }

    @Delete('bundles/:id')
    @CheckPolicies((ability) => ability.can(Action.Delete, 'StudentFee'))
    @RequireAction('finance.student_overrides#bundle.manage')
    async deleteBundle(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @CurrentUser() user: IJwtStaffPayload) {
        const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
        await this.studentFeesService.deleteBundle(id, user, changedBy);
        return {
            success: true,
            message: 'Bundle deleted successfully',
        };
    }

    @Get('bundles/:studentId')
    @CheckPolicies((ability) => ability.can(Action.Read, 'StudentFee'))
    @RequireAction('finance.student_overrides#view')
    async getBundlesByStudent(@Param('studentId', ParseIntPipe) studentId: number, @CurrentUser() user: IJwtStaffPayload) {
        const bundles = await this.studentFeesService.getBundlesByStudent(studentId, user);
        return { success: true, message: 'Bundles retrieved successfully', data: bundles };
    }

    // ─── Bulk Operations ──────────────────────────────────────────────────────

    @Get('bulk-preview')
    @CheckPolicies((ability) => ability.can(Action.Read, 'StudentFee') || ability.can(Action.Manage, 'all'))
    @RequireAction('finance.student_overrides#bulk_ops.view')
    async bulkPreview(
        @Query('campus_id', ParseIntPipe) campus_id: number,
        @Query('academic_year') academic_year: string,
        @Query('fee_type_id', ParseIntPipe) fee_type_id: number,
        @Query('fee_date') fee_date: string,
        @CurrentUser() user: IJwtStaffPayload,
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
        }, user);
        return { success: true, data };
    }

    @Post('bulk-add')
    @HttpCode(HttpStatus.OK)
    @CheckPolicies((ability) => ability.can(Action.Create, 'StudentFee') || ability.can(Action.Manage, 'all'))
    @RequireAction('finance.student_overrides#bulk_ops.add')
    async bulkAdd(@Body() dto: any, @Req() req: Request, @CurrentUser() user: IJwtStaffPayload) {
        const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
        const data = await this.studentFeesService.bulkAdd(dto, user, changedBy);
        return { success: true, data };
    }

    @Get('bulk-add-range-conflicts')
    @CheckPolicies((ability) => ability.can(Action.Read, 'StudentFee') || ability.can(Action.Manage, 'all'))
    @RequireAction('finance.student_overrides#bulk_ops.view')
    async bulkAddRangeConflicts(
        @Query('campus_id', ParseIntPipe) campus_id: number,
        @Query('academic_year') academic_year: string,
        @Query('fee_type_id', ParseIntPipe) fee_type_id: number,
        @Query('start_month', ParseIntPipe) start_month: number,
        @Query('end_month', ParseIntPipe) end_month: number,
        @Query('day', ParseIntPipe) day: number,
        @CurrentUser() user: IJwtStaffPayload,
        @Query('class_id') class_id?: string,
        @Query('section_id') section_id?: string,
    ) {
        const data = await this.studentFeesService.bulkAddRangeConflicts({
            campus_id, academic_year, fee_type_id, start_month, end_month, day,
            class_id: class_id ? Number(class_id) : undefined,
            section_id: section_id ? Number(section_id) : undefined,
        }, user);
        return { success: true, data };
    }

    @Post('bulk-add-range')
    @HttpCode(HttpStatus.OK)
    @CheckPolicies((ability) => ability.can(Action.Create, 'StudentFee') || ability.can(Action.Manage, 'all'))
    @RequireAction('finance.student_overrides#bulk_ops.add')
    async bulkAddRange(@Body() dto: any, @Req() req: Request, @CurrentUser() user: IJwtStaffPayload) {
        const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
        const data = await this.studentFeesService.bulkAddRange(dto, user, changedBy);
        return { success: true, data };
    }

    @Get('bulk-delete-preview')
    @CheckPolicies((ability) => ability.can(Action.Read, 'StudentFee') || ability.can(Action.Manage, 'all'))
    @RequireAction('finance.student_overrides#bulk_ops.view')
    async bulkDeletePreview(
        @Query('campus_id', ParseIntPipe) campus_id: number,
        @Query('academic_year') academic_year: string,
        @Query('fee_date') fee_date: string,
        @CurrentUser() user: IJwtStaffPayload,
        @Query('class_id') class_id?: string,
        @Query('section_id') section_id?: string,
        @Query('fee_type_id') fee_type_id?: string,
    ) {
        const data = await this.studentFeesService.bulkDeletePreview({
            campus_id, academic_year, fee_date,
            class_id: class_id ? Number(class_id) : undefined,
            section_id: section_id ? Number(section_id) : undefined,
            fee_type_id: fee_type_id ? Number(fee_type_id) : undefined,
        }, user);
        return { success: true, data };
    }

    @Get('bulk-delete-range-preview')
    @CheckPolicies((ability) => ability.can(Action.Read, 'StudentFee') || ability.can(Action.Manage, 'all'))
    @RequireAction('finance.student_overrides#bulk_ops.view')
    async bulkDeleteRangePreview(
        @Query('campus_id', ParseIntPipe) campus_id: number,
        @Query('academic_year') academic_year: string,
        @Query('start_month', ParseIntPipe) start_month: number,
        @Query('end_month', ParseIntPipe) end_month: number,
        @Query('day', ParseIntPipe) day: number,
        @CurrentUser() user: IJwtStaffPayload,
        @Query('class_id') class_id?: string,
        @Query('section_id') section_id?: string,
        @Query('fee_type_id') fee_type_id?: string,
    ) {
        const data = await this.studentFeesService.bulkDeleteRangePreview({
            campus_id, academic_year, start_month, end_month, day,
            class_id: class_id ? Number(class_id) : undefined,
            section_id: section_id ? Number(section_id) : undefined,
            fee_type_id: fee_type_id ? Number(fee_type_id) : undefined,
        }, user);
        return { success: true, data };
    }

    @Delete('bulk-delete')
    @HttpCode(HttpStatus.OK)
    @CheckPolicies((ability) => ability.can(Action.Delete, 'StudentFee') || ability.can(Action.Manage, 'all'))
    @RequireAction('finance.student_overrides#bulk_ops.delete')
    async bulkDelete(@Body() dto: any, @Req() req: Request, @CurrentUser() user: IJwtStaffPayload) {
        const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
        const data = await this.studentFeesService.bulkDelete(dto, user, changedBy);
        return { success: true, data };
    }

    // ─── Fee-head Year Transfer ───────────────────────────────────────────────

    @Get('transfer-preview')
    @CheckPolicies((ability) => ability.can(Action.Read, 'StudentFee') || ability.can(Action.Manage, 'all'))
    @RequireAction('finance.student_overrides#transfer')
    async transferPreview(
        @Query('student_fee_ids') student_fee_ids: string,
        @Query('target_academic_year') target_academic_year: string,
        @Query('target_term_start_month', ParseIntPipe) target_term_start_month: number,
        @CurrentUser() user: IJwtStaffPayload,
    ) {
        const ids = (student_fee_ids ?? '')
            .split(',')
            .map((s) => Number(s.trim()))
            .filter((n) => Number.isInteger(n) && n > 0);
        const data = await this.studentFeesService.transferPreview({
            student_fee_ids: ids,
            target_academic_year,
            target_term_start_month,
        }, user);
        return { success: true, data };
    }

    // Admin-only: this rewrites records that may already be paid and receipted.
    @Patch('transfer')
    @HttpCode(HttpStatus.OK)
    @CheckPolicies((ability) => ability.can(Action.Manage, 'all'))
    @RequireAction('finance.student_overrides#transfer')
    async transferHeads(@Body() dto: TransferHeadsDto, @Req() req: Request, @CurrentUser() user: IJwtStaffPayload) {
        const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
        const data = await this.studentFeesService.transferHeads(dto, user, changedBy);
        return { success: true, data };
    }

    // ─── Discount Row Endpoints ───────────────────────────────────────────────

    @Post('discount')
    @HttpCode(HttpStatus.CREATED)
    @CheckPolicies((ability) => ability.can(Action.Create, 'StudentFee') || ability.can(Action.Manage, 'all'))
    @RequireAction('finance.student_overrides#discount.manage')
    async createDiscount(@Body() body: CreateDiscountDto, @Req() req: Request, @CurrentUser() user: IJwtStaffPayload) {
        const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
        const data = await this.studentFeesService.createDiscount(body, user, changedBy);
        return { success: true, data };
    }

    @Delete('discount/:id')
    @HttpCode(HttpStatus.OK)
    @CheckPolicies((ability) => ability.can(Action.Delete, 'StudentFee') || ability.can(Action.Manage, 'all'))
    @RequireAction('finance.student_overrides#discount.manage')
    async deleteDiscount(@Param('id', ParseIntPipe) id: number, @Req() req: Request, @CurrentUser() user: IJwtStaffPayload) {
        const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
        const data = await this.studentFeesService.deleteDiscount(id, user, changedBy);
        return { success: true, data };
    }

    // ─── Scholarship Endpoints ──────────────────────────────────────────────────

    // "Universal" scholarship setter — writes one percentage onto every existing
    // MTF row for a student in an academic year (a student's scholarship is
    // normally constant for the whole year).
    @Post('apply-scholarship')
    @HttpCode(HttpStatus.OK)
    @CheckPolicies((ability) => ability.can(Action.Update, 'StudentFee') || ability.can(Action.Manage, 'all'))
    @RequireAction('finance.student_overrides#scholarship.manage')
    async applyScholarship(@Body() body: ApplyScholarshipDto, @Req() req: Request, @CurrentUser() user: IJwtStaffPayload) {
        const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
        const data = await this.studentFeesService.applyScholarshipToStudent(body, user, changedBy);
        return { success: true, data };
    }

    // ─── Fee Waiver Endpoints ─────────────────────────────────────────────────
    // Loose heads only (not on any voucher). Heads that sit on a voucher are
    // waived through the whole voucher: POST /v1/vouchers/:id/waive.

    @Post('waive')
    @HttpCode(HttpStatus.OK)
    @CheckPolicies((ability) => ability.can(Action.Update, 'StudentFee') || ability.can(Action.Manage, 'all'))
    @RequireAction('finance.student_overrides#waive')
    async waiveHeads(@Body() body: WaiveHeadsDto, @Req() req: Request, @CurrentUser() user: IJwtStaffPayload) {
        const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
        const data = await this.studentFeesService.waiveHeads(body.student_fee_ids, body.reason, user, changedBy);
        return { success: true, message: 'Fee head(s) waived.', data };
    }

    @Post('unwaive')
    @HttpCode(HttpStatus.OK)
    @CheckPolicies((ability) => ability.can(Action.Update, 'StudentFee') || ability.can(Action.Manage, 'all'))
    @RequireAction('finance.student_overrides#waive')
    async unwaiveHeads(@Body() body: UnwaiveHeadsDto, @Req() req: Request, @CurrentUser() user: IJwtStaffPayload) {
        const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
        const data = await this.studentFeesService.unwaiveHeads(body.student_fee_ids, user, changedBy);
        return { success: true, message: 'Fee head waiver reversed.', data };
    }

    @Delete('reset/:studentId')
    @HttpCode(HttpStatus.OK)
    @CheckPolicies((ability) => ability.can(Action.Manage, 'all'))
    @RequireAction('finance.student_overrides#reset')
    async resetAllHeads(@Param('studentId', ParseIntPipe) studentId: number, @Req() req: Request, @CurrentUser() user: IJwtStaffPayload) {
        const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
        const data = await this.studentFeesService.resetAllHeads(studentId, user, changedBy);
        return { success: true, data };
    }
}
