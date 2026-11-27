import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseIntPipe,
    Patch,
    Post,
    Put,
    Query,
    Res,
    UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtParentGuard } from '../../common/guards/jwt-parent.guard';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { CurrentUser } from '../../decorators/current-user.decorator';
import { RequireAction } from '../../decorators/require-action.decorator';
import { createApiResponse } from '../../utils/serializer.util';
import type { IJwtParentPayload, IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import {
    ExamFeeDatePreviewDto,
    ExamFrontNotePreviewDto,
    ExamIssueDto,
    ExamOverrideDto,
    ExamPresetCreateDto,
    ExamReleaseDto,
    ExamRosterQueryDto,
    ExamUnreleaseDto,
    ExamScheduleListQueryDto,
    ExamScheduleStatusDto,
    ExamScheduleFeeDateDto,
    ExamScheduleUpsertDto,
    ExamStudentFeeDatesDto,
} from './dto/exam-documents.dto';
import { ExamDocumentsService } from './exam-documents.service';

/**
 * TAFSD-510: the Exam Documents tile (student.exam_documents). Every route has
 * its own action; new routes need one too (see the tile's MAINTENANCE note).
 */
@ApiTags('Exam Documents')
@Controller('exam-documents')
@UseGuards(JwtStaffGuard, TileActionGuard)
export class ExamDocumentsController {
    constructor(private readonly service: ExamDocumentsService) {}

    @Get('schedules')
    @ApiOperation({ summary: 'Exam schedules on the campuses you can see' })
    @RequireAction('student.exam_documents#view')
    async list(@Query() query: ExamScheduleListQueryDto, @CurrentUser() user: IJwtStaffPayload) {
        return createApiResponse(await this.service.listSchedules(query, user), HttpStatus.OK, 'Exam schedules fetched');
    }

    @Get('schedules/:id')
    @ApiOperation({ summary: 'One schedule with its classes, papers and notes' })
    @RequireAction('student.exam_documents#view')
    async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) {
        return createApiResponse(await this.service.getSchedule(id, user), HttpStatus.OK, 'Exam schedule fetched');
    }

    // TAFSD-524: a read-only copy of a schedule the user can already open, so it
    // sits under #view like the schedule itself.
    @Get('schedules/:id/export')
    @ApiOperation({ summary: "The schedule as an Excel sheet in the school's own layout" })
    @RequireAction('student.exam_documents#view')
    async export(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload, @Res() res: Response) {
        const { buffer, filename } = await this.service.exportSchedule(id, user);
        res.set({
            'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Content-Length': buffer.length,
            'Access-Control-Expose-Headers': 'Content-Disposition',
        });
        res.send(buffer);
    }

    // TAFSD-525: presets a new schedule starts from. Anyone who can see schedules
    // can see the presets; making and removing them is part of managing schedules.
    @Get('presets')
    @ApiOperation({ summary: 'Schedule presets: layout, classes, subjects and notes, without dates' })
    @RequireAction('student.exam_documents#view')
    async presets() {
        return createApiResponse(await this.service.listPresets(), HttpStatus.OK, 'Presets fetched');
    }

    @Post('presets')
    @ApiOperation({ summary: "Save a schedule's layout, classes, subjects and notes as a preset" })
    @RequireAction('student.exam_documents#manage_schedules')
    async createPreset(@Body() dto: ExamPresetCreateDto, @CurrentUser() user: IJwtStaffPayload) {
        return createApiResponse(await this.service.createPreset(dto, user), HttpStatus.CREATED, 'Preset saved');
    }

    @Delete('presets/:id')
    @ApiOperation({ summary: 'Remove a preset. Schedules made from it are not touched' })
    @RequireAction('student.exam_documents#manage_schedules')
    async deletePreset(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) {
        return createApiResponse(await this.service.deletePreset(id, user), HttpStatus.OK, 'Preset removed');
    }

    @Post('schedules/front-note-preview')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Live preview of an unsaved schedule's front note: each class's front page as it would print" })
    @RequireAction('student.exam_documents#manage_schedules')
    async previewFrontNote(@Body() dto: ExamFrontNotePreviewDto, @CurrentUser() user: IJwtStaffPayload) {
        return createApiResponse(await this.service.previewFrontNote(dto, user), HttpStatus.OK, 'Front note preview');
    }

    @Post('schedules')
    @ApiOperation({ summary: 'Create a schedule (as a draft)' })
    @RequireAction('student.exam_documents#manage_schedules')
    async create(@Body() dto: ExamScheduleUpsertDto, @CurrentUser() user: IJwtStaffPayload) {
        return createApiResponse(await this.service.createSchedule(dto, user), HttpStatus.CREATED, 'Exam schedule created');
    }

    @Put('schedules/:id')
    @ApiOperation({ summary: 'Replace a schedule: details, classes, papers and notes' })
    @RequireAction('student.exam_documents#manage_schedules')
    async update(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: ExamScheduleUpsertDto,
        @CurrentUser() user: IJwtStaffPayload,
    ) {
        return createApiResponse(await this.service.updateSchedule(id, dto, user), HttpStatus.OK, 'Exam schedule saved');
    }

    @Patch('schedules/:id/status')
    @ApiOperation({ summary: 'Publish a schedule, or take it back to draft' })
    @RequireAction('student.exam_documents#manage_schedules')
    async status(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: ExamScheduleStatusDto,
        @CurrentUser() user: IJwtStaffPayload,
    ) {
        return createApiResponse(await this.service.setStatus(id, dto.status, user), HttpStatus.OK, 'Exam schedule updated');
    }

    @Delete('schedules/:id')
    @ApiOperation({ summary: 'Delete a schedule no document has been issued from' })
    @RequireAction('student.exam_documents#manage_schedules')
    async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) {
        return createApiResponse(await this.service.deleteSchedule(id, user), HttpStatus.OK, 'Exam schedule deleted');
    }

    @Patch('schedules/:id/fee-date')
    @ApiOperation({ summary: "Change the schedule's fee date. Students with their own date keep it" })
    @RequireAction('student.exam_documents#manage_schedules')
    async feeDate(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: ExamScheduleFeeDateDto,
        @CurrentUser() user: IJwtStaffPayload,
    ) {
        return createApiResponse(await this.service.setScheduleFeeDate(id, dto.fee_date, user), HttpStatus.OK, 'Fee date changed');
    }

    @Get('schedules/:id/fee-dates')
    @ApiOperation({ summary: "Fee dates this schedule's students are billed on, and how much of each is on a voucher" })
    @RequireAction('student.exam_documents#view')
    async feeDates(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) {
        return createApiResponse(await this.service.feeDateOptions(id, user), HttpStatus.OK, 'Fee dates fetched');
    }

    @Put('schedules/:id/student-fee-dates')
    @ApiOperation({ summary: "Give selected students their own fee date, or put them back on the schedule's (fee_date null)" })
    @RequireAction('student.exam_documents#change_fee_dates')
    async studentFeeDates(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: ExamStudentFeeDatesDto,
        @CurrentUser() user: IJwtStaffPayload,
    ) {
        return createApiResponse(await this.service.setStudentFeeDates(id, dto, user), HttpStatus.OK, 'Fee dates saved');
    }

    @Post('schedules/:id/student-fee-dates/preview')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'How the selected students would stand against a fee date, before saving it' })
    @RequireAction('student.exam_documents#view')
    async previewFeeDate(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: ExamFeeDatePreviewDto,
        @CurrentUser() user: IJwtStaffPayload,
    ) {
        return createApiResponse(await this.service.previewFeeDate(id, dto, user), HttpStatus.OK, 'Preview');
    }

    @Get('schedules/:id/students')
    @ApiOperation({ summary: 'Students on the schedule: cleared, owing, not billed, or already issued, each against their fee date' })
    @RequireAction('student.exam_documents#view')
    async roster(
        @Param('id', ParseIntPipe) id: number,
        @Query() query: ExamRosterQueryDto,
        @CurrentUser() user: IJwtStaffPayload,
    ) {
        return createApiResponse(await this.service.roster(id, query, user), HttpStatus.OK, 'Students fetched');
    }

    @Post('schedules/:id/documents')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary:
            'Issue to cleared students and reprint for holders, as one PDF. Students who cannot get one are skipped and listed in the run report (X-Run-Id). With nothing to print the reply is the report summary as JSON',
    })
    @RequireAction('student.exam_documents#issue')
    async issue(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: ExamIssueDto,
        @CurrentUser() user: IJwtStaffPayload,
        @Res() res: Response,
    ) {
        const out = await this.service.issue(id, dto, user);
        res.set({
            'X-Run-Id': out.run_id == null ? '' : String(out.run_id),
            'X-Skipped-Count': String(out.skipped),
            'Access-Control-Expose-Headers': 'Content-Disposition, X-Issued-Count, X-Reprinted-Count, X-Skipped-Count, X-Run-Id',
        });
        if (out.buffer) return this.sendPdf(res, { ...out, buffer: out.buffer });
        res.set({ 'X-Issued-Count': String(out.issued), 'X-Reprinted-Count': String(out.reprinted) });
        res.status(HttpStatus.OK).json(
            createApiResponse(
                { run_id: out.run_id, issued: out.issued, reprinted: out.reprinted, skipped: out.skipped, error: out.error },
                HttpStatus.OK,
                out.error ?? 'Nothing was printed. See the report for why.',
            ),
        );
    }

    // TAFSD-543: the report of each Issue run. Read-only, so it sits under #view
    // like the roster, which already shows the same dues.
    @Get('schedules/:id/runs')
    @ApiOperation({ summary: 'Issue runs on this schedule, newest first, with their counts' })
    @RequireAction('student.exam_documents#view')
    async runs(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) {
        return createApiResponse(await this.service.listRuns(id, user), HttpStatus.OK, 'Issue runs fetched');
    }

    @Get('schedules/:id/runs/:runId')
    @ApiOperation({ summary: 'One issue run: every student asked for, and why those skipped got no document' })
    @RequireAction('student.exam_documents#view')
    async run(
        @Param('id', ParseIntPipe) id: number,
        @Param('runId', ParseIntPipe) runId: number,
        @CurrentUser() user: IJwtStaffPayload,
    ) {
        return createApiResponse(await this.service.getRun(id, runId, user), HttpStatus.OK, 'Issue run fetched');
    }

    @Get('schedules/:id/runs/:runId/export')
    @ApiOperation({ summary: 'An issue run report as an Excel sheet' })
    @RequireAction('student.exam_documents#view')
    async exportRun(
        @Param('id', ParseIntPipe) id: number,
        @Param('runId', ParseIntPipe) runId: number,
        @CurrentUser() user: IJwtStaffPayload,
        @Res() res: Response,
    ) {
        const { buffer, filename } = await this.service.exportRun(id, runId, user);
        res.set({
            'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Content-Length': buffer.length,
            'Access-Control-Expose-Headers': 'Content-Disposition',
        });
        res.send(buffer);
    }

    // TAFSD-544: its own action, because it reaches every parent in the release.
    @Post('schedules/:id/documents/release')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Release issued documents to the parent app: a push, and a document card on the Notice Board' })
    @RequireAction('student.exam_documents#release')
    async release(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: ExamReleaseDto,
        @CurrentUser() user: IJwtStaffPayload,
    ) {
        const out = await this.service.release(id, dto, user);
        return createApiResponse(out, HttpStatus.OK, `${out.released} released to the app`);
    }

    @Post('schedules/:id/documents/unrelease')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Undo a release: the card leaves the parent app. No notification is sent' })
    @RequireAction('student.exam_documents#release')
    async unrelease(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: ExamUnreleaseDto,
        @CurrentUser() user: IJwtStaffPayload,
    ) {
        const out = await this.service.unrelease(id, dto, user);
        return createApiResponse(out, HttpStatus.OK, `${out.unreleased} taken out of the app`);
    }

    @Post('schedules/:id/documents/override')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Issue to one student who still owes dues, with a reason' })
    @RequireAction('student.exam_documents#override_dues')
    async override(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: ExamOverrideDto,
        @CurrentUser() user: IJwtStaffPayload,
        @Res() res: Response,
    ) {
        this.sendPdf(res, await this.service.override(id, dto, user));
    }

    private sendPdf(res: Response, out: { buffer: Buffer; filename: string; issued: number; reprinted: number }) {
        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="${out.filename}"`,
            'Content-Length': out.buffer.length,
            'X-Issued-Count': String(out.issued),
            'X-Reprinted-Count': String(out.reprinted),
            'Access-Control-Expose-Headers': 'Content-Disposition, X-Issued-Count, X-Reprinted-Count, X-Skipped-Count, X-Run-Id',
        });
        res.send(out.buffer);
    }
}

/**
 * TAFSD-544: the parent app's side. A family sees the exam documents released to
 * it as Notice Board cards and opens each one's PDF; nothing else.
 */
@ApiTags('Exam Document Notifications')
@Controller('exam-document-notifications')
@UseGuards(JwtParentGuard)
export class ExamDocumentNotificationsController {
    constructor(private readonly service: ExamDocumentsService) {}

    @Get()
    @ApiOperation({ summary: "The family's exam document cards, newest first, 20 at a time (cursor: the last id)" })
    async list(@CurrentUser() user: IJwtParentPayload, @Query('cursor') cursor?: string) {
        const c = cursor ? parseInt(cursor, 10) : undefined;
        return createApiResponse(
            await this.service.familyNotifications(user.familyId, Number.isFinite(c) ? c : undefined),
            HttpStatus.OK,
            'Exam documents fetched',
        );
    }

    @Post(':id/read')
    @ApiOperation({ summary: 'Mark a card read' })
    async read(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtParentPayload) {
        return createApiResponse(await this.service.markFamilyNotificationRead(id, user.familyId), HttpStatus.OK, 'Marked as read');
    }

    @Get(':id/pdf')
    @ApiOperation({ summary: "The document's current PDF. Records that the parent opened it" })
    async pdf(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtParentPayload, @Res() res: Response) {
        const { buffer, filename } = await this.service.familyNotificationPdf(id, user.familyId);
        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': `inline; filename="${filename}"`,
            'Content-Length': buffer.length,
            'Access-Control-Expose-Headers': 'Content-Disposition',
        });
        res.send(buffer);
    }
}
