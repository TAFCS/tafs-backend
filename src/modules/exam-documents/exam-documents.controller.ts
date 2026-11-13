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
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { CurrentUser } from '../../decorators/current-user.decorator';
import { RequireAction } from '../../decorators/require-action.decorator';
import { createApiResponse } from '../../utils/serializer.util';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import {
    ExamFeeDatePreviewDto,
    ExamIssueDto,
    ExamOverrideDto,
    ExamRosterQueryDto,
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
    @ApiOperation({ summary: 'Issue to cleared students and reprint for holders, as one PDF' })
    @RequireAction('student.exam_documents#issue')
    async issue(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: ExamIssueDto,
        @CurrentUser() user: IJwtStaffPayload,
        @Res() res: Response,
    ) {
        this.sendPdf(res, await this.service.issue(id, dto, user));
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
            'Access-Control-Expose-Headers': 'Content-Disposition, X-Issued-Count, X-Reprinted-Count',
        });
        res.send(out.buffer);
    }
}
