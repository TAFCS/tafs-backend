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
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { RequireAction } from '../../decorators/require-action.decorator';
import { Action } from '../auth/casl/actions';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { auditActorLabel } from '../../common/utils/audit-actor.util';

// Employee-facing routes (getFeed/markRead) stay on JwtStaffGuard alone —
// every employee reads their own feed. Only the admin broadcast routes were
// missing authorization entirely: no PoliciesGuard, no @CheckPolicies, and
// the capability meant to gate them (communication.send_employee_
// announcements) was never actually wired into CASL — see
// casl-ability.factory.ts and subjects.ts (new 'EmployeeNotice' subject).
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
  @UseGuards(PoliciesGuard, TileActionGuard)
  @CheckPolicies((ability) => ability.can(Action.Read, 'EmployeeNotice'))
  @RequireAction('hr.employee_notices#view')
  @ApiOperation({ summary: 'Admin: list all employee notices with read stats' })
  adminList() {
    return this.service.getAdminList();
  }

  @Post('admin/employee-notices')
  @UseGuards(PoliciesGuard, TileActionGuard)
  @CheckPolicies((ability) => ability.can(Action.Manage, 'EmployeeNotice'))
  @RequireAction('hr.employee_notices#create')
  @ApiOperation({ summary: 'Admin: create an employee notice and fan-out FCM' })
  create(@CurrentUser() user: IJwtStaffPayload, @Body() dto: CreateEmployeeNoticeDto) {
    return this.service.createPost(dto, user, auditActorLabel(user));
  }

  @Patch('admin/employee-notices/:id')
  @UseGuards(PoliciesGuard, TileActionGuard)
  @CheckPolicies((ability) => ability.can(Action.Manage, 'EmployeeNotice'))
  @RequireAction('hr.employee_notices#edit')
  @ApiOperation({ summary: 'Admin: edit an employee notice' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateEmployeeNoticeDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    return this.service.updatePost(id, dto, auditActorLabel(user), user);
  }

  @Delete('admin/employee-notices/:id')
  @UseGuards(PoliciesGuard, TileActionGuard)
  @CheckPolicies((ability) => ability.can(Action.Manage, 'EmployeeNotice'))
  @RequireAction('hr.employee_notices#delete')
  @ApiOperation({ summary: 'Admin: soft-delete an employee notice' })
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) {
    return this.service.deletePost(id, auditActorLabel(user));
  }
}
