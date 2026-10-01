import {
  applyDecorators,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../../common/guards/policies.guard';
import { TileActionGuard } from '../../../common/guards/tile-action.guard';
import { RequireAction } from '../../../decorators/require-action.decorator';
import { CheckPolicies } from '../../../decorators/check-policies.decorator';
import { CurrentUser } from '../../../decorators/current-user.decorator';
import { Action } from '../../auth/casl/actions';
import { TicketRoutingAdminService } from './ticket-routing-admin.service';
import {
  CreateRoutingRuleDto,
  CreateTicketQueueDto,
  RoutingPreviewDto,
  UpdateRoutingRuleDto,
  UpdateTicketQueueDto,
} from './dto/routing-admin.dto';

const canManageTickets = (ability: any) =>
  ability.can(Action.Manage, 'SupportTicket') || ability.can(Action.Manage, 'all');

/**
 * Every route: staff JWT, CASL manage on SupportTicket, the tile's
 * manage_replies action, plus a SUPER_ADMIN check in the service. Applied per
 * method because PoliciesGuard reads handler metadata only.
 */
const ManageRouting = () =>
  applyDecorators(
    UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard),
    CheckPolicies(canManageTickets),
    RequireAction('communication.support_tickets#manage_replies'),
  );

/**
 * Routing management. Gated on the tile's manage_replies action plus a
 * SUPER_ADMIN check in the service, until routing gets its own tile action.
 */
@ApiTags('Support Ticket Routing')
@ApiBearerAuth()
@Controller('support-ticket-routing')
export class TicketRoutingAdminController {
  constructor(private readonly admin: TicketRoutingAdminService) {}

  @ManageRouting()
  @Get()
  @ApiOperation({ summary: 'Rules, queues and picker options' })
  overview(@CurrentUser() staff: any) {
    return this.admin.overview(staff);
  }

  @ManageRouting()
  @Get('health')
  @ApiOperation({ summary: 'Gaps: inactive targets, empty queues, uncovered classes' })
  health(@CurrentUser() staff: any) {
    return this.admin.health(staff);
  }

  @ManageRouting()
  @Post('preview')
  @ApiOperation({ summary: 'Where a ticket would go, and why' })
  preview(@CurrentUser() staff: any, @Body() dto: RoutingPreviewDto) {
    return this.admin.preview(staff, dto);
  }

  @ManageRouting()
  @Get('user-impact/:userId')
  @ApiOperation({ summary: 'Rules and queues that depend on a staff member' })
  userImpact(@CurrentUser() staff: any, @Param('userId') userId: string) {
    return this.admin.userImpact(staff, userId);
  }

  @ManageRouting()
  @Post('rules')
  createRule(@CurrentUser() staff: any, @Body() dto: CreateRoutingRuleDto) {
    return this.admin.createRule(staff, dto);
  }

  @ManageRouting()
  @Patch('rules/:id')
  updateRule(
    @CurrentUser() staff: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateRoutingRuleDto,
  ) {
    return this.admin.updateRule(staff, id, dto);
  }

  @ManageRouting()
  @Delete('rules/:id')
  deleteRule(@CurrentUser() staff: any, @Param('id', ParseIntPipe) id: number) {
    return this.admin.deleteRule(staff, id);
  }

  @ManageRouting()
  @Post('queues')
  createQueue(@CurrentUser() staff: any, @Body() dto: CreateTicketQueueDto) {
    return this.admin.createQueue(staff, dto);
  }

  @ManageRouting()
  @Patch('queues/:id')
  updateQueue(
    @CurrentUser() staff: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateTicketQueueDto,
  ) {
    return this.admin.updateQueue(staff, id, dto);
  }

  @ManageRouting()
  @Delete('queues/:id')
  deleteQueue(@CurrentUser() staff: any, @Param('id', ParseIntPipe) id: number) {
    return this.admin.deleteQueue(staff, id);
  }
}
