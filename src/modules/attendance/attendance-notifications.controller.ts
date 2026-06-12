import { Controller, Get, HttpStatus, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtParentGuard } from '../../common/guards/jwt-parent.guard';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { IJwtParentPayload } from '../auth/interfaces/jwt-payload.interface';
import { createApiResponse } from '../../utils/serializer.util';
import { AttendanceNotificationsService } from './attendance-notifications.service';

@ApiTags('Attendance Notifications')
@ApiBearerAuth()
@Controller('attendance-notifications')
export class AttendanceNotificationsController {
  constructor(private readonly service: AttendanceNotificationsService) {}

  @Get()
  @UseGuards(JwtParentGuard)
  async getFeed(@CurrentUser() user: IJwtParentPayload, @Query('cursor') cursor?: string) {
    const data = await this.service.getForFamily(user.familyId, cursor ? parseInt(cursor, 10) : undefined);
    return createApiResponse(data, HttpStatus.OK, 'Attendance notifications retrieved');
  }

  @Post(':id/read')
  @UseGuards(JwtParentGuard)
  async markRead(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtParentPayload) {
    const data = await this.service.markRead(id, user.familyId);
    return createApiResponse(data, HttpStatus.OK, 'Notification marked as read');
  }
}
