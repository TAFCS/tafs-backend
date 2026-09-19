import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { RequireAction } from '../../decorators/require-action.decorator';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { createApiResponse } from '../../utils/serializer.util';
import {
  CreatePostdatedChequeDto,
  PostdatedChequesService,
  UpdateStatusDto,
} from './postdated-cheques.service';
import { ListPostdatedChequesQueryDto } from './dto/list-postdated-cheques.dto';

// Gated by the tile's own actions (finance.postdated_cheques#...). `view` is
// the class-wide default; the three writes override it on their handler. No
// role holds the tile by default: a SUPER_ADMIN (who passes TileActionGuard
// unconditionally) grants it per role or person in People & Access. Every read
// and write is also limited to the caller's universal scope by way of the
// cheque's student.
@ApiTags('postdated-cheques')
@Controller('postdated-cheques')
@UseGuards(JwtStaffGuard, TileActionGuard)
@RequireAction('finance.postdated_cheques#view')
export class PostdatedChequesController {
  constructor(private readonly svc: PostdatedChequesService) {}

  @Post()
  @RequireAction('finance.postdated_cheques#create')
  @ApiOperation({ summary: 'Record a new post-dated cheque' })
  async create(
    @Body() dto: CreatePostdatedChequeDto,
    @Req() req: Request,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
    return createApiResponse(await this.svc.create(dto, changedBy, user), HttpStatus.CREATED, 'Cheque recorded');
  }

  @Get('alerts')
  @ApiOperation({ summary: 'Get pending cheques due for cashing (Home page alert)' })
  async getAlerts(@CurrentUser() user: IJwtStaffPayload) {
    return createApiResponse(await this.svc.getDue(user), HttpStatus.OK, 'Cheque alerts retrieved');
  }

  @Get()
  @ApiOperation({ summary: 'List all cheques with optional filters' })
  async list(@Query() query: ListPostdatedChequesQueryDto, @CurrentUser() user: IJwtStaffPayload) {
    return createApiResponse(
      await this.svc.list({
        status: query.status,
        student_id: query.student_id,
        campus_id: query.campus_id,
        from_date: query.from_date,
        to_date: query.to_date,
      }, user),
      HttpStatus.OK,
      'Cheques retrieved',
    );
  }

  @Get('due')
  @ApiOperation({ summary: 'Get all pending cheques due today or overdue' })
  async getDue(@CurrentUser() user: IJwtStaffPayload) {
    return createApiResponse(await this.svc.getDue(user), HttpStatus.OK, 'Due cheques retrieved');
  }

  @Get('student/:cc')
  @ApiOperation({ summary: 'Get all cheques for a specific student' })
  async getByStudent(@Param('cc', ParseIntPipe) cc: number, @CurrentUser() user: IJwtStaffPayload) {
    return createApiResponse(
      await this.svc.getByStudent(cc, user),
      HttpStatus.OK,
      'Student cheques retrieved',
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single cheque by ID' })
  async findOne(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) {
    return createApiResponse(await this.svc.findOne(id, user), HttpStatus.OK, 'Cheque retrieved');
  }

  @Patch(':id/status')
  @RequireAction('finance.postdated_cheques#update_status')
  @ApiOperation({ summary: 'Update cheque status (CASHED, BOUNCED, RETURNED, CANCELLED)' })
  async updateStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateStatusDto,
    @Req() req: Request,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
    return createApiResponse(
      await this.svc.updateStatus(id, dto, changedBy, user),
      HttpStatus.OK,
      'Status updated',
    );
  }

  @Delete(':id')
  @RequireAction('finance.postdated_cheques#delete')
  @ApiOperation({ summary: 'Delete a cheque record' })
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: Request,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
    await this.svc.remove(id, changedBy, user);
    return createApiResponse(null, HttpStatus.OK, 'Cheque deleted');
  }
}
