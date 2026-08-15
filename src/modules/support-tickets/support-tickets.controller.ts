import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { JwtParentGuard } from '../../common/guards/jwt-parent.guard';
import { JwtStaffOrParentGuard } from '../../common/guards/jwt-staff-or-parent.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';
import { CurrentUser } from '../../decorators/current-user.decorator';
import { ChatService } from '../chat/chat.service';
import { SupportTicketsService } from './support-tickets.service';
import { parsePagination } from './support-tickets-pagination';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { CreateTicketMessageDto } from './dto/create-ticket-message.dto';
import { ReviewTicketMessageDto } from './dto/review-ticket-message.dto';
import { TransferTicketDto } from './dto/transfer-ticket.dto';
import { ForwardTicketDto } from './dto/forward-ticket.dto';
import { CloseTicketDto } from './dto/close-ticket.dto';
import { MarkTicketReadDto } from './dto/mark-ticket-read.dto';

const canViewTickets = (ability: any) =>
  ability.can(Action.Read, 'SupportTicket') || ability.can(Action.Manage, 'all');

const canManageTickets = (ability: any) =>
  ability.can(Action.Manage, 'SupportTicket') || ability.can(Action.Manage, 'all');

@ApiTags('Support Tickets')
@ApiBearerAuth()
@Controller('support-tickets')
export class SupportTicketsController {
  constructor(
    private readonly supportTicketsService: SupportTicketsService,
    private readonly chatService: ChatService,
  ) {}

  @Get('origination-options')
  @UseGuards(JwtParentGuard)
  @ApiOperation({ summary: 'MCQ questionnaire options for new tickets' })
  getOriginationOptions() {
    return this.supportTicketsService.getOriginationOptions();
  }

  @Get('mine')
  @UseGuards(JwtParentGuard)
  @ApiOperation({ summary: 'List tickets for the current parent family' })
  listMine(
    @CurrentUser() parent: any,
    @Query('status') status?: 'open' | 'closed',
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    const pagination = parsePagination(take, skip);
    return this.supportTicketsService.listParentTickets(
      parent,
      status,
      pagination.take,
      pagination.skip,
    );
  }

  @Post()
  @UseGuards(JwtParentGuard)
  @ApiOperation({ summary: 'Create a new support ticket' })
  createTicket(@CurrentUser() parent: any, @Body() dto: CreateTicketDto) {
    return this.supportTicketsService.createTicket(parent, dto);
  }

  @Post('mark-read')
  @UseGuards(JwtStaffOrParentGuard, PoliciesGuard)
  @CheckPolicies(canViewTickets)
  @ApiOperation({ summary: 'Mark ticket read (staff or parent)' })
  markRead(@CurrentUser() user: any, @Body() dto: MarkTicketReadDto) {
    return this.supportTicketsService.markRead(dto.ticketId, user);
  }

  @Get('my-queue')
  @UseGuards(JwtStaffGuard, PoliciesGuard)
  @CheckPolicies(canViewTickets)
  @ApiOperation({ summary: 'Open tickets assigned to the current staff member' })
  myQueue(
    @CurrentUser() staff: any,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    const pagination = parsePagination(take, skip);
    return this.supportTicketsService.listMyQueue(
      staff,
      pagination.take,
      pagination.skip,
    );
  }

  @Get('finance-queue')
  @UseGuards(JwtStaffGuard, PoliciesGuard)
  @CheckPolicies(canViewTickets)
  @ApiOperation({ summary: 'Shared finance ticket queue' })
  financeQueue(
    @CurrentUser() staff: any,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    const pagination = parsePagination(take, skip);
    return this.supportTicketsService.listFinanceQueue(
      staff,
      pagination.take,
      pagination.skip,
    );
  }

  @Get('oversight')
  @UseGuards(JwtStaffGuard, PoliciesGuard)
  @CheckPolicies(canViewTickets)
  @ApiOperation({ summary: 'Super Admin view of all open tickets' })
  oversightQueue(
    @CurrentUser() staff: any,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    const pagination = parsePagination(take, skip);
    return this.supportTicketsService.listOversightQueue(
      staff,
      pagination.take,
      pagination.skip,
    );
  }

  @Get('closed')
  @UseGuards(JwtStaffGuard, PoliciesGuard)
  @CheckPolicies(canViewTickets)
  @ApiOperation({ summary: 'Closed ticket history (role-filtered)' })
  closedTickets(
    @CurrentUser() staff: any,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    const pagination = parsePagination(take, skip);
    return this.supportTicketsService.listClosedTickets(
      staff,
      pagination.take,
      pagination.skip,
    );
  }

  @Get('approvals/pending')
  @UseGuards(JwtStaffGuard, PoliciesGuard)
  @CheckPolicies(canManageTickets)
  @ApiOperation({ summary: 'Super Admin pending reply approval queue' })
  pendingApprovals(@CurrentUser() staff: any) {
    return this.supportTicketsService.listPendingApprovals(staff);
  }

  @Patch('messages/:messageId/review')
  @UseGuards(JwtStaffGuard, PoliciesGuard)
  @CheckPolicies(canManageTickets)
  @ApiOperation({ summary: 'Super Admin approve or reject a staff reply' })
  reviewMessage(
    @Param('messageId') messageId: string,
    @Body() dto: ReviewTicketMessageDto,
    @CurrentUser() staff: any,
  ) {
    return this.supportTicketsService.reviewReply(messageId, dto, staff);
  }

  @Delete('messages/:messageId')
  @UseGuards(JwtStaffGuard, PoliciesGuard)
  @CheckPolicies(canManageTickets)
  @ApiOperation({ summary: 'Super Admin soft-delete own ticket message (tombstone)' })
  deleteMessage(
    @Param('messageId') messageId: string,
    @CurrentUser() staff: any,
  ) {
    return this.supportTicketsService.deleteOwnStaffMessage(messageId, staff);
  }

  @Post('media')
  @UseGuards(JwtStaffOrParentGuard, PoliciesGuard)
  @CheckPolicies(canViewTickets)
  @ApiOperation({ summary: 'Upload ticket attachment (delegates to chat media pipeline)' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  uploadMedia(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    return this.chatService.uploadMedia(file);
  }

  @Get(':id')
  @UseGuards(JwtStaffOrParentGuard, PoliciesGuard)
  @CheckPolicies(canViewTickets)
  @ApiOperation({ summary: 'Get ticket detail with messages' })
  getTicket(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    const pagination = parsePagination(take, skip, 100);
    return this.supportTicketsService.getTicketById(
      id,
      user,
      pagination.take,
      pagination.skip,
    );
  }

  @Post(':id/claim')
  @UseGuards(JwtStaffGuard, PoliciesGuard)
  @CheckPolicies(canViewTickets)
  claimTicket(@Param('id') id: string, @CurrentUser() staff: any) {
    return this.supportTicketsService.claimTicket(id, staff);
  }

  @Post(':id/transfer')
  @UseGuards(JwtStaffGuard, PoliciesGuard)
  @CheckPolicies(canViewTickets)
  transferTicket(
    @Param('id') id: string,
    @Body() dto: TransferTicketDto,
    @CurrentUser() staff: any,
  ) {
    return this.supportTicketsService.transferTicket(id, dto.targetUserId, staff);
  }

  @Post(':id/forward')
  @UseGuards(JwtStaffGuard, PoliciesGuard)
  @CheckPolicies(canViewTickets)
  forwardTicket(
    @Param('id') id: string,
    @Body() dto: ForwardTicketDto,
    @CurrentUser() staff: any,
  ) {
    return this.supportTicketsService.forwardTicket(id, dto.targetUserId, staff);
  }

  @Post(':id/messages')
  @UseGuards(JwtStaffOrParentGuard, PoliciesGuard)
  @CheckPolicies(canViewTickets)
  createMessage(
    @Param('id') id: string,
    @Body() dto: CreateTicketMessageDto,
    @CurrentUser() user: any,
  ) {
    if (user.userType === 'STAFF') {
      return this.supportTicketsService.createStaffMessage(id, user, dto);
    }
    return this.supportTicketsService.createParentMessage(id, user, dto);
  }

  @Post(':id/close')
  @UseGuards(JwtStaffOrParentGuard, PoliciesGuard)
  @CheckPolicies(canViewTickets)
  closeTicket(
    @Param('id') id: string,
    @Body() dto: CloseTicketDto,
    @CurrentUser() user: any,
  ) {
    if (user.userType === 'STAFF') {
      return this.supportTicketsService.closeByStaff(id, user, dto);
    }
    return this.supportTicketsService.closeByParent(id, user, dto);
  }
}
