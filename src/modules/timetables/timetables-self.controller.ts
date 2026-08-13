import { Controller, Get, HttpStatus, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { NotFoundException } from '@nestjs/common';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { createApiResponse } from '../../utils/serializer.util';
import { PrismaService } from '../../../prisma/prisma.service';
import { TimetablesService } from './timetables.service';

@ApiTags('Timetables Self')
@ApiBearerAuth()
@Controller('timetables')
@UseGuards(JwtStaffGuard)
export class TimetablesSelfController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly service: TimetablesService,
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

    const [slots, blocks] = await Promise.all([
      this.service.listTeacherWeeklySlots(employee.id),
      this.service.listBlocks(),
    ]);
    const blockByNumber = new Map(blocks.map((b) => [b.block_number, b]));

    const data = slots.map((slot) => {
      const block = blockByNumber.get(slot.block_number);
      return {
        ...slot,
        start_time: block?.start_time ?? null,
        end_time: block?.end_time ?? null,
        label: block?.label ?? null,
      };
    });

    return createApiResponse(data, HttpStatus.OK, 'Weekly schedule retrieved');
  }
}
