import { Controller, Get, Post, Patch, Delete, Param, Body, ParseIntPipe, HttpStatus, UseGuards } from '@nestjs/common';
import { StudentFlagsService } from './student-flags.service';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { createApiResponse } from '../../utils/serializer.util';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';

@ApiTags('student-flags')
@ApiBearerAuth()
@Controller('student-flags')
@UseGuards(JwtStaffGuard)
export class StudentFlagsController {
  constructor(private readonly svc: StudentFlagsService) {}

  // Static paths before :cc so Nest does not treat "all" as a student id.
  @Get('all/notifications/count')
  @ApiOperation({ summary: 'Count pending notifications (reminder_date <= now)' })
  async pendingNotificationsCount(@CurrentUser() user: IJwtStaffPayload) {
    return createApiResponse(
      { count: await this.svc.countPendingNotifications(user) },
      HttpStatus.OK,
      'Pending notification count retrieved',
    );
  }

  @Get('all/notifications')
  @ApiOperation({ summary: 'Get all pending notifications (reminder_date <= now)' })
  async pendingNotifications(@CurrentUser() user: IJwtStaffPayload) {
    return createApiResponse(
      await this.svc.getPendingNotifications(user),
      HttpStatus.OK,
      'Pending notifications retrieved',
    );
  }

  @Get(':cc')
  @ApiOperation({ summary: 'Get all flags for a student' })
  async getFlags(@Param('cc', ParseIntPipe) cc: number, @CurrentUser() user: IJwtStaffPayload) {
    await this.svc.assertStudentVisible(user, cc);
    return createApiResponse(await this.svc.getFlags(cc), HttpStatus.OK, 'Flags retrieved');
  }

  @Post(':cc')
  @ApiOperation({ summary: 'Add a flag with optional reminder date' })
  async addFlag(
    @Param('cc', ParseIntPipe) cc: number,
    @Body('flag') flag: string,
    @Body('reminder_date') reminderDate: string | undefined,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    await this.svc.assertStudentVisible(user, cc);
    const date = reminderDate ? new Date(reminderDate) : undefined;
    return createApiResponse(await this.svc.addFlag(cc, flag, date, user.username), HttpStatus.OK, 'Flag added');
  }

  @Patch(':cc/:flag/done')
  @ApiOperation({ summary: 'Mark a flag as work done' })
  async markDone(
    @Param('cc', ParseIntPipe) cc: number,
    @Param('flag') flag: string,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    await this.svc.assertStudentVisible(user, cc);
    return createApiResponse(await this.svc.markWorkDone(cc, flag, user.username), HttpStatus.OK, 'Status updated');
  }

  @Delete(':cc/:flag')
  @ApiOperation({ summary: 'Remove a flag' })
  async removeFlag(
    @Param('cc', ParseIntPipe) cc: number,
    @Param('flag') flag: string,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    await this.svc.assertStudentVisible(user, cc);
    return createApiResponse(await this.svc.removeFlag(cc, flag, user.username), HttpStatus.OK, 'Flag removed');
  }
}
