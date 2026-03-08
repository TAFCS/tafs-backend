import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  ParseIntPipe,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import { StaffEditingService } from './staff-editing.service';
import { GetSheetStudentsDto } from './dto/get-sheet-students.dto';
import { UpdateStudentDto } from './dto/update-student.dto';
import { CreateGuardianDto } from './dto/create-guardian.dto';
import { UpdateGuardianDto } from './dto/update-guardian.dto';
import { UpdateGuardianRelationshipDto } from './dto/update-guardian-relationship.dto';
import { createApiResponse } from '../../utils/serializer.util';
import { STAFF_EDITING_MESSAGES } from '../../constants/api-response/staff-editing.constant';

@Controller('staff-editing')
export class StaffEditingController {
  constructor(private readonly staffEditingService: StaffEditingService) {}

  // ─── Students ─────────────────────────────────────────────────────────────

  @Get('students')
  async getStudents(@Query() query: GetSheetStudentsDto) {
    const result = await this.staffEditingService.getStudents(query);
    return createApiResponse(
      result,
      HttpStatus.OK,
      STAFF_EDITING_MESSAGES.STUDENTS_LIST_SUCCESS,
    );
  }

  @Get('students/:id')
  async getStudent(@Param('id', ParseIntPipe) id: number) {
    const student = await this.staffEditingService.getStudent(id);
    return createApiResponse(
      student,
      HttpStatus.OK,
      STAFF_EDITING_MESSAGES.STUDENT_RETRIEVE_SUCCESS,
    );
  }

  @Patch('students/:id')
  async updateStudent(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateStudentDto,
  ) {
    const student = await this.staffEditingService.updateStudent(id, dto);
    return createApiResponse(
      student,
      HttpStatus.OK,
      STAFF_EDITING_MESSAGES.STUDENT_UPDATE_SUCCESS,
    );
  }

  // ─── Student → Guardians ────────────────────────────────────────────────

  @Get('students/:studentId/guardians')
  async getStudentGuardians(
    @Param('studentId', ParseIntPipe) studentId: number,
  ) {
    const guardians =
      await this.staffEditingService.getStudentGuardians(studentId);
    return createApiResponse(
      guardians,
      HttpStatus.OK,
      STAFF_EDITING_MESSAGES.GUARDIANS_LIST_SUCCESS,
    );
  }

  @Post('students/:studentId/guardians')
  async addGuardianToStudent(
    @Param('studentId', ParseIntPipe) studentId: number,
    @Body() dto: CreateGuardianDto,
  ) {
    const guardian = await this.staffEditingService.addGuardianToStudent(
      studentId,
      dto,
    );
    return createApiResponse(
      guardian,
      HttpStatus.CREATED,
      STAFF_EDITING_MESSAGES.GUARDIAN_CREATE_SUCCESS,
    );
  }

  @Patch('students/:studentId/guardians/:guardianId')
  async updateGuardianRelationship(
    @Param('studentId', ParseIntPipe) studentId: number,
    @Param('guardianId', ParseIntPipe) guardianId: number,
    @Body() dto: UpdateGuardianRelationshipDto,
  ) {
    const result = await this.staffEditingService.updateGuardianRelationship(
      studentId,
      guardianId,
      dto,
    );
    return createApiResponse(
      result,
      HttpStatus.OK,
      STAFF_EDITING_MESSAGES.GUARDIAN_RELATIONSHIP_UPDATE_SUCCESS,
    );
  }

  @Delete('students/:studentId/guardians/:guardianId')
  @HttpCode(HttpStatus.OK)
  async removeGuardianFromStudent(
    @Param('studentId', ParseIntPipe) studentId: number,
    @Param('guardianId', ParseIntPipe) guardianId: number,
  ) {
    await this.staffEditingService.removeGuardianFromStudent(
      studentId,
      guardianId,
    );
    return createApiResponse(
      null,
      HttpStatus.OK,
      STAFF_EDITING_MESSAGES.GUARDIAN_UNLINKED_SUCCESS,
    );
  }

  // ─── Guardians (standalone) ───────────────────────────────────────────────

  @Get('guardians/:id')
  async getGuardian(@Param('id', ParseIntPipe) id: number) {
    const guardian = await this.staffEditingService.getGuardian(id);
    return createApiResponse(
      guardian,
      HttpStatus.OK,
      STAFF_EDITING_MESSAGES.GUARDIAN_RETRIEVE_SUCCESS,
    );
  }

  @Patch('guardians/:id')
  async updateGuardian(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateGuardianDto,
  ) {
    const guardian = await this.staffEditingService.updateGuardian(id, dto);
    return createApiResponse(
      guardian,
      HttpStatus.OK,
      STAFF_EDITING_MESSAGES.GUARDIAN_UPDATE_SUCCESS,
    );
  }
}
