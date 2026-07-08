import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Query,
  Param,
  ParseIntPipe,
  UseGuards,
  HttpStatus,
  Req,
  BadRequestException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';
import { createApiResponse } from '../../utils/serializer.util';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { TimetablesService } from './timetables.service';
import { EmployeeExpectedTimesService } from './employee-expected-times.service';
import {
  CreateTimetableDto,
  DaySlotsQueryDto,
  TimetableGridQueryDto,
  UpsertSlotDto,
} from './dto/timetables.dto';
import { PrismaService } from '../../../prisma/prisma.service';

@ApiTags('Timetables')
@ApiBearerAuth()
@Controller('timetables')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class TimetablesController {
  constructor(
    private readonly service: TimetablesService,
    private readonly expectedTimes: EmployeeExpectedTimesService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('blocks')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Timetable'))
  async listBlocks() {
    const data = await this.service.listBlocks();
    return createApiResponse(data, HttpStatus.OK, 'Timetable blocks retrieved');
  }

  @Get('day-slots')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Timetable'))
  async getDaySlots(
    @Query() query: DaySlotsQueryDto,
    @Req() req: { user: IJwtStaffPayload },
  ) {
    const data = await this.service.getDaySlots(
      query.campus_id,
      query.class_id,
      query.section_id,
      query.date,
      req.user,
    );
    return createApiResponse(data, HttpStatus.OK, 'Day slots retrieved');
  }

  @Get('grid')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Timetable'))
  async getGrid(
    @Query() query: TimetableGridQueryDto,
    @Req() req: { user: IJwtStaffPayload },
  ) {
    const data = await this.service.getGrid(
      query.campus_id,
      query.class_id,
      query.section_id,
      query.academic_year,
      req.user,
    );
    return createApiResponse(data, HttpStatus.OK, 'Timetable grid retrieved');
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Timetable'))
  async getOrCreate(
    @Body() dto: CreateTimetableDto,
    @Req() req: { user: IJwtStaffPayload },
  ) {
    const data = await this.service.getOrCreate(
      dto.campus_id,
      dto.class_id,
      dto.section_id,
      dto.academic_year,
      req.user,
    );
    return createApiResponse(data, HttpStatus.OK, 'Timetable ready');
  }

  @Put(':timetableId/slots')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Timetable'))
  async upsertSlot(
    @Param('timetableId', ParseIntPipe) timetableId: number,
    @Body() dto: UpsertSlotDto,
    @Req() req: { user: IJwtStaffPayload },
  ) {
    const data = await this.service.upsertSlot(timetableId, dto, req.user);
    return createApiResponse(data, HttpStatus.OK, 'Slot saved');
  }

  @Delete('slots/:slotId')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Timetable'))
  async deleteSlot(
    @Param('slotId', ParseIntPipe) slotId: number,
    @Req() req: { user: IJwtStaffPayload },
  ) {
    const data = await this.service.deleteSlot(slotId, req.user);
    return createApiResponse(data, HttpStatus.OK, 'Slot deleted');
  }

  @Get('teachers/:employeeId/slots')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Timetable'))
  async listTeacherSlots(
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Query('academic_year') academicYear?: string,
  ) {
    const data = await this.service.listTeacherWeeklySlots(employeeId, academicYear);
    return createApiResponse(data, HttpStatus.OK, 'Teacher weekly slots retrieved');
  }

  @Get('teachers/:employeeId/expected-times')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Timetable'))
  async getExpectedTimes(
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Query('date') dateStr?: string,
  ) {
    if (!dateStr) throw new BadRequestException('date is required (YYYY-MM-DD)');
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) throw new BadRequestException('Invalid date');
    date.setUTCHours(0, 0, 0, 0);

    const employee = await this.prisma.employee_profiles.findUnique({
      where: { id: employeeId },
      select: { id: true, campus_id: true, check_in_source: true },
    });
    if (!employee) throw new BadRequestException('Employee not found');

    const resolved = await this.expectedTimes.resolveExpectedTimes(
      employeeId,
      employee.campus_id ?? 0,
      date,
    );
    return createApiResponse(
      {
        employee_id: employeeId,
        date: dateStr.slice(0, 10),
        check_in_source: employee.check_in_source,
        ...resolved,
      },
      HttpStatus.OK,
      'Expected times resolved',
    );
  }
}
