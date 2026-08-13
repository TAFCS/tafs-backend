import {
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtParentGuard } from '../../common/guards/jwt-parent.guard';
import { createApiResponse } from '../../utils/serializer.util';
import { PrismaService } from '../../../prisma/prisma.service';
import { TeachingGroupsService } from './teaching-groups.service';

@ApiTags('Timetables Parent')
@ApiBearerAuth()
@Controller('timetables/parent')
@UseGuards(JwtParentGuard)
export class TimetablesParentController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly teachingGroups: TeachingGroupsService,
  ) {}

  @Get('student/:cc/schedule')
  @HttpCode(HttpStatus.OK)
  async getStudentSchedule(
    @Param('cc', ParseIntPipe) cc: number,
    @Req() req: any,
  ) {
    const familyId = req.user.familyId;
    const student = await this.prisma.students.findFirst({
      where: { cc, family_id: familyId, deleted_at: null },
      select: { cc: true },
    });
    if (!student) {
      throw new ForbiddenException(`Student #${cc} not linked to your family`);
    }

    const data = await this.teachingGroups.getStudentWeeklySlots(cc);
    return createApiResponse(data, HttpStatus.OK, 'Weekly schedule retrieved');
  }
}
