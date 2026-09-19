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
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { CurrentUser } from '../../decorators/current-user.decorator';
import { RequireAction } from '../../decorators/require-action.decorator';
import { Action } from '../auth/casl/actions';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { CreateClassFeeScheduleDto } from './dto/create-class-fee-schedule.dto';
import { BulkUpdateClassFeeScheduleDto } from './dto/bulk-update-class-fee-schedule.dto';

// GET /by-class is deliberately left without @RequireAction — it's read by
// the Student Overrides tile (TabAddSingle.tsx / studentwise-fees page) to
// suggest default fee amounts, unrelated to who administers class fee
// schedules. Gating it would lock Student Overrides users out of a feature
// their own tile depends on. The coarse @CheckPolicies stays as its only gate.
@Controller('class-fee-schedule')
@UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
export class ClassFeeScheduleController {
  constructor(private readonly classFeeScheduleService: ClassFeeScheduleService) { }

  @Get()
  @CheckPolicies(
    (ability) =>
      ability.can(Action.Read, 'ClassFeeSchedule') ||
      ability.can(Action.Manage, 'all'),
  )
  @RequireAction('finance.class_fee_schedule#view')
  async findAll(@Query('academic_year') academicYear: string | undefined, @CurrentUser() user: IJwtStaffPayload) {
    const schedules = await this.classFeeScheduleService.findAll(academicYear, user);
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
  @RequireAction('finance.class_fee_schedule#create')
  async create(@Body() dto: CreateClassFeeScheduleDto, @Req() req: Request, @CurrentUser() user: IJwtStaffPayload) {
    const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
    const created = await this.classFeeScheduleService.create(dto, changedBy, user);
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
  @RequireAction('finance.class_fee_schedule#edit')
  async bulkUpdate(@Body() dto: BulkUpdateClassFeeScheduleDto, @Req() req: Request, @CurrentUser() user: IJwtStaffPayload) {
    const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
    const updated = await this.classFeeScheduleService.bulkUpdate(dto, changedBy, user);
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
  @RequireAction('finance.class_fee_schedule#delete')
  async remove(@Param('id') id: string, @Req() req: Request, @CurrentUser() user: IJwtStaffPayload) {
    const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
    await this.classFeeScheduleService.remove(Number(id), changedBy, user);
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
  @RequireAction('finance.class_fee_schedule#copy_history')
  async copyHistory(@Body() body: { from_year: string; to_year: string }) {
    const result = await this.classFeeScheduleService.copyHistory(body.from_year, body.to_year);
    return {
      success: true,
      message: `Successfully copied ${result.count} records from ${body.from_year} to ${body.to_year}.`,
      data: result,
    };
  }
}
