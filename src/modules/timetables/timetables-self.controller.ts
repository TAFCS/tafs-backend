import { Controller, Get, HttpStatus, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { NotFoundException } from '@nestjs/common';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { createApiResponse } from '../../utils/serializer.util';
import { PrismaService } from '../../../prisma/prisma.service';
import { TimetablesService } from './timetables.service';
import { ClassPeriodsService } from './class-periods.service';

@ApiTags('Timetables Self')
@ApiBearerAuth()
@Controller('timetables')
@UseGuards(JwtStaffGuard)
export class TimetablesSelfController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly service: TimetablesService,
    private readonly classPeriods: ClassPeriodsService,
  ) {}

  @Get('me')
  async getMine(@CurrentUser() user: IJwtStaffPayload) {
    const employee = await this.prisma.employee_profiles.findUnique({
      where: { user_id: user.sub },
      select: { id: true },
    });
    if (!employee) {
      throw new NotFoundException('No employee profile linked to this account');
    }

    const slots = await this.service.listTeacherWeeklySlots(employee.id);
    // Each slot's own class may run a different bell schedule, so times are
    // resolved per (campus, class, block) rather than off one shared list.
    const periods = await this.classPeriods.resolveMany(
      slots.map((slot) => ({
        campus_id: slot.timetables.campus_id,
        class_id: slot.timetables.class_id,
        block_number: slot.block_number,
      })),
    );

    const data = slots.map((slot) => {
      const period = periods.get(
        `${slot.timetables.campus_id}:${slot.timetables.class_id}:${slot.block_number}`,
      );
      return {
        ...slot,
        start_time: period?.start_time ?? null,
        end_time: period?.end_time ?? null,
        label: period?.label ?? null,
      };
    });

    return createApiResponse(data, HttpStatus.OK, 'Weekly schedule retrieved');
  }
}
