import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Delete,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ClassFeeScheduleService } from './class-fee-schedule.service';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';
import { CreateClassFeeScheduleDto } from './dto/create-class-fee-schedule.dto';
import { BulkUpdateClassFeeScheduleDto } from './dto/bulk-update-class-fee-schedule.dto';

@Controller('class-fee-schedule')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class ClassFeeScheduleController {
  constructor(private readonly classFeeScheduleService: ClassFeeScheduleService) { }

  @Get()
  @CheckPolicies(
    (ability) =>
      ability.can(Action.Read, 'ClassFeeSchedule') ||
      ability.can(Action.Manage, 'all'),
  )
  async findAll(@Query('academic_year') academicYear?: string) {
    const schedules = await this.classFeeScheduleService.findAll(academicYear);
    return {
      success: true,
      message: 'Class fee schedules retrieved successfully',
      data: schedules,
    };
  }

  @Get('by-class')
  @CheckPolicies(
    (ability) =>
      ability.can(Action.Read, 'ClassFeeSchedule') ||
      ability.can(Action.Manage, 'all'),
  )
  async findByClass(
    @Query('class_id') classId: string,
    @Query('campus_id') campusId?: string,
    @Query('academic_year') academicYear?: string,
  ) {
    const parsedClassId = Number(classId);
    const parsedCampusId = campusId ? Number(campusId) : undefined;

    if (isNaN(parsedClassId) || parsedClassId <= 0) {
      return {
        success: true,
        message: 'Invalid class ID provided',
        data: [],
      };
    }

    const schedules = await this.classFeeScheduleService.findByClassId(
      parsedClassId,
      parsedCampusId,
      academicYear,
    );

    return {
      success: true,
      message: 'Class fee schedule retrieved successfully',
      data: schedules,
    };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @CheckPolicies(
    (ability) =>
      ability.can(Action.Create, 'ClassFeeSchedule') ||
      ability.can(Action.Manage, 'all'),
  )
  async create(@Body() dto: CreateClassFeeScheduleDto, @Req() req: Request) {
    const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
    const created = await this.classFeeScheduleService.create(dto, changedBy);
    return {
      success: true,
      message: 'Class fee schedule created successfully',
      data: created,
    };
  }

  @Patch('bulk')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies(
    (ability) =>
      ability.can(Action.Update, 'ClassFeeSchedule') ||
      ability.can(Action.Manage, 'all'),
  )
  async bulkUpdate(@Body() dto: BulkUpdateClassFeeScheduleDto, @Req() req: Request) {
    const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
    const updated = await this.classFeeScheduleService.bulkUpdate(dto, changedBy);
    return {
      success: true,
      message: 'Class fee schedules updated successfully',
      data: updated,
    };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies(
    (ability) =>
      ability.can(Action.Delete, 'ClassFeeSchedule') ||
      ability.can(Action.Manage, 'all'),
  )
  async remove(@Param('id') id: string, @Req() req: Request) {
    const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
    await this.classFeeScheduleService.remove(Number(id), changedBy);
    return {
      success: true,
      message: 'Class fee schedule deleted successfully',
    };
  }

  @Post('copy-history')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies(
    (ability) =>
      ability.can(Action.Create, 'ClassFeeSchedule') ||
      ability.can(Action.Manage, 'all'),
  )
  async copyHistory(@Body() body: { from_year: string; to_year: string }) {
    const result = await this.classFeeScheduleService.copyHistory(body.from_year, body.to_year);
    return {
      success: true,
      message: `Successfully copied ${result.count} records from ${body.from_year} to ${body.to_year}.`,
      data: result,
    };
  }
}
