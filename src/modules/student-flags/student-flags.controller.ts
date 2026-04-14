import { Controller, Get, Post, Patch, Delete, Param, Body, ParseIntPipe, HttpStatus, Query } from '@nestjs/common';
import { StudentFlagsService } from './student-flags.service';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { createApiResponse } from '../../utils/serializer.util';

@ApiTags('student-flags')
@Controller('student-flags')
export class StudentFlagsController {
  constructor(private readonly svc: StudentFlagsService) {}

  @Get(':cc')
  @ApiOperation({ summary: 'Get all flags for a student' })
  async getFlags(@Param('cc', ParseIntPipe) cc: number) {
    return createApiResponse(await this.svc.getFlags(cc), HttpStatus.OK, 'Flags retrieved');
  }

  @Post(':cc')
  @ApiOperation({ summary: 'Add a flag with optional reminder date' })
  async addFlag(
    @Param('cc', ParseIntPipe) cc: number, 
    @Body('flag') flag: string,
    @Body('reminder_date') reminderDate?: string
  ) {
    const date = reminderDate ? new Date(reminderDate) : undefined;
    return createApiResponse(await this.svc.addFlag(cc, flag, date), HttpStatus.OK, 'Flag added');
  }

  @Patch(':cc/:flag/done')
  @ApiOperation({ summary: 'Mark a flag as work done' })
  async markDone(
    @Param('cc', ParseIntPipe) cc: number,
    @Param('flag') flag: string
  ) {
    return createApiResponse(await this.svc.markWorkDone(cc, flag), HttpStatus.OK, 'Status updated');
  }

  @Delete(':cc/:flag')
  @ApiOperation({ summary: 'Remove a flag' })
  async removeFlag(
    @Param('cc', ParseIntPipe) cc: number, 
    @Param('flag') flag: string
  ) {
    return createApiResponse(await this.svc.removeFlag(cc, flag), HttpStatus.OK, 'Flag removed');
  }

  @Get('all/notifications')
  @ApiOperation({ summary: 'Get all pending notifications (reminder_date <= now)' })
  async pendingNotifications() {
    return createApiResponse(
      await this.svc.getPendingNotifications(),
      HttpStatus.OK,
      'Pending notifications retrieved'
    );
  }
}
