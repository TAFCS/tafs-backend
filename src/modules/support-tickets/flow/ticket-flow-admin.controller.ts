import {
  applyDecorators,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
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
import { TicketFlowService } from './ticket-flow.service';
import {
  FlowRouteAllDto,
  FlowRoutePreviewDto,
  OpenFlowDraftDto,
  PublishFlowDto,
  SaveFlowDraftDto,
} from './dto/ticket-flow.dto';

const canManageTickets = (ability: any) =>
  ability.can(Action.Manage, 'SupportTicket') ||
  ability.can(Action.Manage, 'all');

/** Same gate as routing management: staff JWT, CASL manage, manage_replies, plus SUPER_ADMIN in the service. */
const ManageFlow = () =>
  applyDecorators(
    UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard),
    CheckPolicies(canManageTickets),
    RequireAction('communication.support_tickets#manage_replies'),
  );

/** The ticket flow builder (TAFSD-447): lanes and question trees parents walk to open a ticket. */
@ApiTags('Support Ticket Flow')
@ApiBearerAuth()
@Controller('support-ticket-flow')
export class TicketFlowAdminController {
  constructor(private readonly flow: TicketFlowService) {}

  @ManageFlow()
  @Get()
  @ApiOperation({ summary: 'Published flow, open draft and picker options' })
  overview(@CurrentUser() staff: any) {
    return this.flow.overview(staff);
  }

  @ManageFlow()
  @Post('draft')
  @ApiOperation({ summary: 'Open the draft (or restore a version into it)' })
  openDraft(@CurrentUser() staff: any, @Body() dto: OpenFlowDraftDto) {
    return this.flow.openDraft(staff, dto.from_version);
  }

  @ManageFlow()
  @Put('draft')
  @ApiOperation({ summary: 'Save the whole draft tree' })
  saveDraft(@CurrentUser() staff: any, @Body() dto: SaveFlowDraftDto) {
    return this.flow.saveDraft(staff, dto.tree, dto.lock_version);
  }

  @ManageFlow()
  @Delete('draft')
  discardDraft(@CurrentUser() staff: any) {
    return this.flow.discardDraft(staff);
  }

  @ManageFlow()
  @Post('draft/validate')
  @ApiOperation({ summary: 'Problems to fix and what publishing would change' })
  validate(@CurrentUser() staff: any) {
    return this.flow.validateDraft(staff);
  }

  @ManageFlow()
  @Post('draft/publish')
  publish(@CurrentUser() staff: any, @Body() dto: PublishFlowDto) {
    return this.flow.publish(staff, dto.notes, dto.lock_version);
  }

  @ManageFlow()
  @Get('versions')
  versions(@CurrentUser() staff: any) {
    return this.flow.versions(staff);
  }

  @ManageFlow()
  @Get('versions/:version')
  version(
    @CurrentUser() staff: any,
    @Param('version', ParseIntPipe) version: number,
  ) {
    return this.flow.version(staff, version);
  }

  @ManageFlow()
  @Post('preview-route')
  @ApiOperation({ summary: 'Where a ticket from this path would go, and why' })
  previewRoute(@CurrentUser() staff: any, @Body() dto: FlowRoutePreviewDto) {
    return this.flow.previewRoute(
      staff,
      dto.path,
      dto.student_cc ?? null,
      dto.draft ?? true,
    );
  }

  @ManageFlow()
  @Post('route-all')
  @ApiOperation({
    summary: 'Destination of every ticket leaf for one sample child',
  })
  routeAll(@CurrentUser() staff: any, @Body() dto: FlowRouteAllDto) {
    return this.flow.routeAll(staff, dto.student_cc ?? null, dto.draft ?? true);
  }
}
