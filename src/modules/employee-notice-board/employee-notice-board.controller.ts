import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { EmployeeNoticeBoardService } from './employee-notice-board.service';
import { CreateEmployeeNoticeDto } from './dto/create-employee-notice.dto';
import { UpdateEmployeeNoticeDto } from './dto/update-employee-notice.dto';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';

@ApiTags('Employee Notice Board')
@ApiBearerAuth()
@UseGuards(JwtStaffGuard)
@Controller()
export class EmployeeNoticeBoardController {
  constructor(private readonly service: EmployeeNoticeBoardService) {}

  // ── Employee-facing routes ────────────────────────────────────────────────

  @Get('hr/employee-notices')
  @ApiOperation({ summary: 'Get employee notice feed for the current user (filtered by role)' })
  getFeed(@CurrentUser() user: IJwtStaffPayload) {
    return this.service.getFeedForUser(user);
  }

  @Post('hr/employee-notices/:id/read')
  @ApiOperation({ summary: 'Mark an employee notice as read' })
  markRead(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    return this.service.markRead(id, user.sub);
  }

  // ── Admin routes ──────────────────────────────────────────────────────────

  @Get('admin/employee-notices')
  @ApiOperation({ summary: 'Admin: list all employee notices with read stats' })
  adminList() {
    return this.service.getAdminList();
  }

  @Post('admin/employee-notices')
  @ApiOperation({ summary: 'Admin: create an employee notice and fan-out FCM' })
  create(@CurrentUser() user: IJwtStaffPayload, @Body() dto: CreateEmployeeNoticeDto) {
    return this.service.createPost(dto, user, user.username || user.sub);
  }

  @Patch('admin/employee-notices/:id')
  @ApiOperation({ summary: 'Admin: edit an employee notice' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateEmployeeNoticeDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    return this.service.updatePost(id, dto, user.username || user.sub);
  }

  @Delete('admin/employee-notices/:id')
  @ApiOperation({ summary: 'Admin: soft-delete an employee notice' })
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) {
    return this.service.deletePost(id, user.username || user.sub);
  }
}
