import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
  Request,
} from '@nestjs/common';
import { ParentChangeRequestsService } from './parent-change-requests.service';
import { CreateChangeRequestDto } from './dto/create-change-request.dto';
import { ProcessChangeRequestDto } from './dto/process-change-request.dto';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { JwtParentGuard } from '../../common/guards/jwt-parent.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { RequireAction } from '../../decorators/require-action.decorator';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';

@Controller('parent-change-requests')
export class ParentChangeRequestsController {
  constructor(private readonly service: ParentChangeRequestsService) {}

  @Post()
  @UseGuards(JwtParentGuard)
  async createRequest(@Body() dto: CreateChangeRequestDto) {
    return this.service.createRequest(dto);
  }

  @Get()
  @UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
  @CheckPolicies((ability) => ability.can(Action.Read, 'Family'))
  @RequireAction('student.parent_change_requests#view')
  async listRequests(@CurrentUser() user: IJwtStaffPayload) {
    return this.service.listRequests(user);
  }

  @Get(':id')
  @UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
  @CheckPolicies((ability) => ability.can(Action.Read, 'Family'))
  @RequireAction('student.parent_change_requests#view')
  async getRequest(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    return this.service.getRequestById(id, user);
  }

  @Patch(':id/process')
  @UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
  @CheckPolicies((ability) => ability.can(Action.Update, 'Family'))
  @RequireAction('student.parent_change_requests#process')
  async processRequest(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ProcessChangeRequestDto,
    @CurrentUser() user: IJwtStaffPayload,
    @Request() req: any,
  ) {
    const adminLabel = user?.username || req?.user?.username || user?.sub || 'system';
    return this.service.processRequest(id, dto, user.sub, adminLabel, user);
  }
}

