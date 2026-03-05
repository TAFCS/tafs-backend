import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, UseGuards } from '@nestjs/common';
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
  constructor(private readonly classFeeScheduleService: ClassFeeScheduleService) {}

  @Get()
  @CheckPolicies(
    (ability) =>
      ability.can(Action.Read, 'ClassFeeSchedule') ||
      ability.can(Action.Manage, 'all'),
  )
  async findAll() {
    const schedules = await this.classFeeScheduleService.findAll();
    return {
      success: true,
      message: 'Class fee schedules retrieved successfully',
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
  async create(@Body() dto: CreateClassFeeScheduleDto) {
    const created = await this.classFeeScheduleService.create(dto);
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
  async bulkUpdate(@Body() dto: BulkUpdateClassFeeScheduleDto) {
    const updated = await this.classFeeScheduleService.bulkUpdate(dto);
    return {
      success: true,
      message: 'Class fee schedules updated successfully',
      data: updated,
    };
  }
}
