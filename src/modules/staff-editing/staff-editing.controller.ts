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
  UseGuards,
} from '@nestjs/common';
import { StaffEditingService } from './staff-editing.service';
import { GetSheetStudentsDto } from './dto/get-sheet-students.dto';
import { UpdateStudentDto } from './dto/update-student.dto';
import { CreateGuardianDto } from './dto/create-guardian.dto';
import { UpdateGuardianDto } from './dto/update-guardian.dto';
import { UpdateGuardianRelationshipDto } from './dto/update-guardian-relationship.dto';
import { LinkExistingGuardianDto } from './dto/link-existing-guardian.dto';
import { HardDeleteStudentDto } from './dto/hard-delete-student.dto';
import { createApiResponse } from '../../utils/serializer.util';
import { STAFF_EDITING_MESSAGES } from '../../constants/api-response/staff-editing.constant';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { RequireAction, RequireAnyAction } from '../../decorators/require-action.decorator';

// TileActionGuard is what enforces @RequireAction. Without it every decorator
// below was inert and any staff login could edit — or hard-delete — any
// student. Routes with no action of their own fall back to the class default.
@Controller('staff-editing')
@UseGuards(JwtStaffGuard, TileActionGuard)
@RequireAction('student.directory#view')
export class StaffEditingController {
  constructor(private readonly staffEditingService: StaffEditingService) {}

  // ─── Students ─────────────────────────────────────────────────────────────

  @Get('students')
  async getStudents(@Query() query: GetSheetStudentsDto, @CurrentUser() user: IJwtStaffPayload) {
    const result = await this.staffEditingService.getStudents(query, user);
    return createApiResponse(
      result,
      HttpStatus.OK,
      STAFF_EDITING_MESSAGES.STUDENTS_LIST_SUCCESS,
    );
  }

  @Get('students/:id')
  async getStudent(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) {
    await this.staffEditingService.assertStudentVisible(user, id);
    const student = await this.staffEditingService.getStudent(id);
    return createApiResponse(
      student,
      HttpStatus.OK,
      STAFF_EDITING_MESSAGES.STUDENT_RETRIEVE_SUCCESS,
    );
  }

  @Patch('students/:id')
  @RequireAction('student.directory#identity.edit')
  async updateStudent(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateStudentDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    await this.staffEditingService.assertStudentVisible(user, id);
    const student = await this.staffEditingService.updateStudent(id, dto, user.username);
    return createApiResponse(
      student,
      HttpStatus.OK,
      STAFF_EDITING_MESSAGES.STUDENT_UPDATE_SUCCESS,
    );
  }
 
  @Delete('students/:id/hard-delete')
  @RequireAction('student.directory#status.change')
  async hardDeleteStudent(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: HardDeleteStudentDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    await this.staffEditingService.assertStudentVisible(user, id);
    const result = await this.staffEditingService.hardDeleteStudent(id, user.username, dto.reason);
    return createApiResponse(
      result,
      HttpStatus.OK,
      STAFF_EDITING_MESSAGES.STUDENT_DELETE_SUCCESS || 'Student permanently deleted',
    );
  }

  @Patch('students/:id/family-address')
  @RequireAction('student.directory#identity.edit')
  async updateFamilyAddress(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: any,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    await this.staffEditingService.assertStudentVisible(user, id);
    const result = await this.staffEditingService.updateFamilyAddress(id, dto, user.username);
    return createApiResponse(
      result,
      HttpStatus.OK,
      'Family mailing address updated successfully',
    );
  }

  // ─── Student → Guardians ────────────────────────────────────────────────

  @Get('students/:studentId/guardians')
  async getStudentGuardians(
    @Param('studentId', ParseIntPipe) studentId: number,
    @CurrentUser() user: IJwtStaffPayload
  ) {
    await this.staffEditingService.assertStudentVisible(user, studentId);
    const guardians =
      await this.staffEditingService.getStudentGuardians(studentId);
    return createApiResponse(
      guardians,
      HttpStatus.OK,
      STAFF_EDITING_MESSAGES.GUARDIANS_LIST_SUCCESS,
    );
  }

  @Post('students/:studentId/guardians')
  @RequireAction('student.directory#guardians.edit')
  async addGuardianToStudent(
    @Param('studentId', ParseIntPipe) studentId: number,
    @Body() dto: CreateGuardianDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    await this.staffEditingService.assertStudentVisible(user, studentId);
    const guardian = await this.staffEditingService.addGuardianToStudent(
      studentId,
      dto,
      user.username,
    );
    return createApiResponse(
      guardian,
      HttpStatus.CREATED,
      STAFF_EDITING_MESSAGES.GUARDIAN_CREATE_SUCCESS,
    );
  }

  @Post('students/:studentId/guardians/link-existing')
  @RequireAction('student.directory#guardians.edit')
  async linkExistingGuardian(
    @Param('studentId', ParseIntPipe) studentId: number,
    @Body() dto: LinkExistingGuardianDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    await this.staffEditingService.assertStudentVisible(user, studentId);
    const guardian = await this.staffEditingService.linkExistingGuardian(
      studentId,
      dto,
      user.username,
    );
    return createApiResponse(
      guardian,
      HttpStatus.OK,
      STAFF_EDITING_MESSAGES.GUARDIAN_LINKED_SUCCESS || 'Guardian linked successfully',
    );
  }

  @Patch('students/:studentId/guardians/:guardianId')
  @RequireAction('student.directory#guardians.edit')
  async updateGuardianRelationship(
    @Param('studentId', ParseIntPipe) studentId: number,
    @Param('guardianId', ParseIntPipe) guardianId: number,
    @Body() dto: UpdateGuardianRelationshipDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    await this.staffEditingService.assertStudentVisible(user, studentId);
    const result = await this.staffEditingService.updateGuardianRelationship(
      studentId,
      guardianId,
      dto,
      user.username,
    );
    return createApiResponse(
      result,
      HttpStatus.OK,
      STAFF_EDITING_MESSAGES.GUARDIAN_RELATIONSHIP_UPDATE_SUCCESS,
    );
  }

  @Delete('students/:studentId/guardians/:guardianId')
  @HttpCode(HttpStatus.OK)
  @RequireAction('student.directory#guardians.edit')
  async removeGuardianFromStudent(
    @Param('studentId', ParseIntPipe) studentId: number,
    @Param('guardianId', ParseIntPipe) guardianId: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    await this.staffEditingService.assertStudentVisible(user, studentId);
    await this.staffEditingService.removeGuardianFromStudent(
      studentId,
      guardianId,
      user.username,
    );
    return createApiResponse(
      null,
      HttpStatus.OK,
      STAFF_EDITING_MESSAGES.GUARDIAN_UNLINKED_SUCCESS,
    );
  }

  // ─── Guardians (standalone) ───────────────────────────────────────────────

  @Get('guardians/:id')
  async getGuardian(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) {
    await this.staffEditingService.assertGuardianVisible(user, id);
    const guardian = await this.staffEditingService.getGuardian(id);
    return createApiResponse(
      guardian,
      HttpStatus.OK,
      STAFF_EDITING_MESSAGES.GUARDIAN_RETRIEVE_SUCCESS,
    );
  }

  @Patch('guardians/:id')
  @RequireAction('student.directory#guardians.edit')
  async updateGuardian(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateGuardianDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    await this.staffEditingService.assertGuardianVisible(user, id);
    const guardian = await this.staffEditingService.updateGuardian(id, dto, user.username);
    return createApiResponse(
      guardian,
      HttpStatus.OK,
      STAFF_EDITING_MESSAGES.GUARDIAN_UPDATE_SUCCESS,
    );
  }

  @Get('guardians/by-nic/:nic')
  async getGuardianByNic(@Param('nic') nic: string, @CurrentUser() user: IJwtStaffPayload) {
    const guardian = await this.staffEditingService.getGuardianByNic(nic);
    return createApiResponse(
      guardian,
      HttpStatus.OK,
      STAFF_EDITING_MESSAGES.GUARDIAN_RETRIEVE_SUCCESS,
    );
  }

  @Delete('guardians/:id')
  @HttpCode(HttpStatus.OK)
  @RequireAction('student.directory#guardians.edit')
  async deleteGuardian(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    await this.staffEditingService.assertGuardianVisible(user, id);
    const result = await this.staffEditingService.deleteGuardian(id, user.username);
    return createApiResponse(
      result,
      HttpStatus.OK,
      STAFF_EDITING_MESSAGES.GUARDIAN_DELETE_SUCCESS,
    );
  }

  // ─── Sub-table CRUD ──────────────────────────────────────────────────────

  @Post('students/:id/admissions')
  @RequireAction('student.directory#admissions.edit')
  async upsertAdmission(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: any,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    await this.staffEditingService.assertStudentVisible(user, id);
    return createApiResponse(await this.staffEditingService.upsertAdmission(id, dto, user.username), HttpStatus.OK, 'Saved');
  }

  @Delete('admissions/:id')
  @HttpCode(HttpStatus.OK)
  @RequireAction('student.directory#admissions.edit')
  async deleteAdmission(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    await this.staffEditingService.assertChildVisible(user, 'admission', id);
    await this.staffEditingService.deleteAdmission(id, user.username);
    return createApiResponse(null, HttpStatus.OK, 'Deleted');
  }

  @Post('students/:id/activities')
  @RequireAction('student.directory#academic.edit')
  async upsertActivity(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: any,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    await this.staffEditingService.assertStudentVisible(user, id);
    return createApiResponse(await this.staffEditingService.upsertActivity(id, dto, user.username), HttpStatus.OK, 'Saved');
  }

  @Delete('activities/:id')
  @HttpCode(HttpStatus.OK)
  @RequireAction('student.directory#academic.edit')
  async deleteActivity(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    await this.staffEditingService.assertChildVisible(user, 'activity', id);
    await this.staffEditingService.deleteActivity(id, user.username);
    return createApiResponse(null, HttpStatus.OK, 'Deleted');
  }

  @Post('students/:id/languages')
  @RequireAction('student.directory#academic.edit')
  async upsertLanguage(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: any,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    await this.staffEditingService.assertStudentVisible(user, id);
    return createApiResponse(await this.staffEditingService.upsertLanguage(id, dto, user.username), HttpStatus.OK, 'Saved');
  }

  @Delete('languages/:id')
  @HttpCode(HttpStatus.OK)
  @RequireAction('student.directory#academic.edit')
  async deleteLanguage(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    await this.staffEditingService.assertChildVisible(user, 'language', id);
    await this.staffEditingService.deleteLanguage(id, user.username);
    return createApiResponse(null, HttpStatus.OK, 'Deleted');
  }

  @Post('students/:id/schools')
  @RequireAction('student.directory#academic.edit')
  async upsertPreviousSchool(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: any,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    await this.staffEditingService.assertStudentVisible(user, id);
    return createApiResponse(await this.staffEditingService.upsertPreviousSchool(id, dto, user.username), HttpStatus.OK, 'Saved');
  }

  @Delete('schools/:id')
  @HttpCode(HttpStatus.OK)
  @RequireAction('student.directory#academic.edit')
  async deletePreviousSchool(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    await this.staffEditingService.assertChildVisible(user, 'school', id);
    await this.staffEditingService.deletePreviousSchool(id, user.username);
    return createApiResponse(null, HttpStatus.OK, 'Deleted');
  }

  @Post('students/:id/alevel-details')
  @RequireAction('student.directory#academic.edit')
  async upsertALevelDetails(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: any,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    await this.staffEditingService.assertStudentVisible(user, id);
    return createApiResponse(await this.staffEditingService.upsertALevelDetails(id, dto, user.username), HttpStatus.OK, 'Saved');
  }
}
