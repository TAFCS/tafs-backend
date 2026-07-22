import { Body, Controller, Get, HttpStatus, Param, ParseIntPipe, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import type { Response } from 'express';
import { StudentsService } from './students.service';
import { GetStudentsDto } from './dto/get-students.dto';
import { PaymentHistoryQueryDto } from './dto/payment-history-query.dto';
import { AssignStudentDto } from './dto/assign-student.dto';
import { PromoteSingleStudentDto } from './dto/promote-single-student.dto';
import { PromoteBulkStudentsDto } from './dto/promote-bulk-students.dto';
import { SuggestGrNumbersDto } from './dto/suggest-gr-numbers.dto';
import { ChangeStatusDto } from './dto/change-status.dto';
import { createApiResponse, createPaginatedApiResponse } from '../../utils/serializer.util';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';
import { STUDENTS_MESSAGES } from '../../constants/api-response/students.constant';

@Controller('students')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class StudentsController {
  constructor(private readonly studentsService: StudentsService) { }

  @Get('search-simple')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Student'))
  async searchSimple(@Query('q') q: string) {
    const results = await this.studentsService.searchSimple(q || '');
    return createApiResponse(
      results,
      HttpStatus.OK,
      'Search results retrieved successfully',
    );
  }

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Student'))
  async findAll(
    @Query() query: GetStudentsDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const { items, meta } = await this.studentsService.findAll(query, user);
    return createPaginatedApiResponse(
      items,
      meta,
      HttpStatus.OK,
      STUDENTS_MESSAGES.LIST_SUCCESS,
    );
  }

  @Get('export')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Student'))
  async exportExcel(
    @Query() query: GetStudentsDto,
    @CurrentUser() user: IJwtStaffPayload,
    @Res() res: Response,
  ) {
    const buffer = await this.studentsService.exportExcel(query, user);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="student-directory-${new Date().toISOString().slice(0, 10)}.xlsx"`,
      'Content-Length': buffer.length,
    });
    res.send(buffer);
  }

  @Post('gr-numbers/suggest-for-promotion')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Student'))
  async suggestGrNumbersForPromotion(@Body() dto: SuggestGrNumbersDto) {
    const assignments = await this.studentsService.suggestGrNumbersForPromotion(
      dto.student_ccs,
      dto.a_level !== false,
    );
    return createApiResponse(
      { assignments },
      HttpStatus.OK,
      'GR number suggestions retrieved successfully',
    );
  }

  @Get(':id')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Student'))
  async findOne(@Param('id', ParseIntPipe) id: number) {
    const student = await this.studentsService.findOne(id);
    return createApiResponse(
      student,
      HttpStatus.OK,
      STUDENTS_MESSAGES.RETRIEVE_SUCCESS,
    );
  }

  @Get(':id/payment-history')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Student'))
  async getPaymentHistory(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: PaymentHistoryQueryDto,
  ) {
    const history = await this.studentsService.getPaymentHistory(
      id,
      query.academic_year,
    );
    return createApiResponse(
      history,
      HttpStatus.OK,
      'Payment history retrieved successfully',
    );
  }

  @Patch(':id/assignment')
  @CheckPolicies((ability) => ability.can(Action.Update, 'Student'))
  async assignStudent(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AssignStudentDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const updated = await this.studentsService.assignStudent(id, dto, user.username);
    return createApiResponse(
      updated,
      HttpStatus.OK,
      'Student assignment updated successfully',
    );
  }

  @Patch(':id/unexpel')
  @CheckPolicies((ability) => ability.can(Action.Update, 'Student'))
  async unexpelStudent(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const updated = await this.studentsService.unexpelStudent(id, user.username);
    return createApiResponse(
      updated,
      HttpStatus.OK,
      'Student unexpelled successfully',
    );
  }

  @Patch(':id/undo-left')
  @CheckPolicies((ability) => ability.can(Action.Update, 'Student'))
  async undoLeftStudent(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const updated = await this.studentsService.undoLeftStudent(id, user.username);
    return createApiResponse(
      updated,
      HttpStatus.OK,
      'Student restored from left successfully',
    );
  }

  @Patch(':id/status')
  @CheckPolicies((ability) => ability.can(Action.Update, 'Student'))
  async changeStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ChangeStatusDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const updated = await this.studentsService.changeStatus(id, dto.status, dto.reason, user.username, user);
    return createApiResponse(
      updated,
      HttpStatus.OK,
      `Student status changed to ${dto.status} successfully`,
    );
  }

  @Post('promotion/single')
  @CheckPolicies((ability) => ability.can(Action.Update, 'Student'))
  async promoteSingle(
    @Body() dto: PromoteSingleStudentDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const result = await this.studentsService.promoteSingle(dto, user.username);
    return createApiResponse(
      result,
      HttpStatus.OK,
      STUDENTS_MESSAGES.PROMOTION_SINGLE_SUCCESS,
    );
  }

  @Post('promotion/bulk')
  @CheckPolicies((ability) => ability.can(Action.Update, 'Student'))
  async promoteBulk(
    @Body() dto: PromoteBulkStudentsDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const result = await this.studentsService.promoteBulk(dto, user.username);
    return createApiResponse(
      result,
      HttpStatus.OK,
      STUDENTS_MESSAGES.PROMOTION_BULK_SUCCESS,
    );
  }

  @Get(':id/academic-history')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Student'))
  async getAcademicHistory(@Param('id', ParseIntPipe) id: number) {
    const history = await this.studentsService.getAcademicHistory(id);
    return createApiResponse(
      history,
      HttpStatus.OK,
      'Academic history retrieved successfully',
    );
  }

  @Get(':id/progression')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Student'))
  async getProgression(@Param('id', ParseIntPipe) id: number) {
    const periods = await this.studentsService.getProgressionPeriods(id);
    return createApiResponse(
      periods,
      HttpStatus.OK,
      'Progression periods retrieved successfully',
    );
  }

  @Get(':id/house-history')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Student'))
  async getHouseHistory(@Param('id', ParseIntPipe) id: number) {
    const history = await this.studentsService.getHouseHistory(id);
    return createApiResponse(
      history,
      HttpStatus.OK,
      'House history retrieved successfully',
    );
  }
}
