import { Controller, Get, HttpStatus, Param, ParseIntPipe, Patch, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { createApiResponse } from '../../utils/serializer.util';
import { StaffNotificationsService } from './staff-notifications.service';

/** TAFSD-429: the signed-in staff member's own notifications. Every route is scoped to `user.sub`. */
@ApiTags('staff-notifications')
@ApiBearerAuth()
@Controller('staff-notifications')
@UseGuards(JwtStaffGuard)
export class StaffNotificationsController {
  constructor(private readonly svc: StaffNotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'My latest notifications and the unread count' })
  async list(@CurrentUser() user: IJwtStaffPayload, @Query('limit') limit?: string) {
    return createApiResponse(await this.svc.list(user.sub, Number(limit) || 30), HttpStatus.OK, 'Notifications retrieved');
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'How many of my notifications are unread' })
  async unreadCount(@CurrentUser() user: IJwtStaffPayload) {
    return createApiResponse({ count: await this.svc.countUnread(user.sub) }, HttpStatus.OK, 'Unread count retrieved');
  }

  @Patch('read-all')
  @ApiOperation({ summary: 'Mark all my notifications read' })
  async markAllRead(@CurrentUser() user: IJwtStaffPayload) {
    return createApiResponse({ updated: await this.svc.markAllRead(user.sub) }, HttpStatus.OK, 'Marked read');
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark one of my notifications read' })
  async markRead(@CurrentUser() user: IJwtStaffPayload, @Param('id', ParseIntPipe) id: number) {
    await this.svc.markRead(user.sub, id);
    return createApiResponse({ id }, HttpStatus.OK, 'Marked read');
  }
}
