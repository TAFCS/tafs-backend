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
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { CurrentUser } from '../../../decorators/current-user.decorator';
import { createApiResponse } from '../../../utils/serializer.util';
import { assertStaffSelfPermission, LEAVE_APPLY } from '../../../common/staff-self-service.util';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { CreateLeaveRequestDto } from './dto/leave-requests.dto';
import { LeaveRequestsService } from './leave-requests.service';

@ApiTags('Leave Requests (Self)')
@ApiBearerAuth()
@Controller('hr/leaves')
@UseGuards(JwtStaffGuard)
export class LeaveRequestsSelfController {
  constructor(private readonly leaveService: LeaveRequestsService) {}

  @Post('me')
  async create(
    @CurrentUser() user: IJwtStaffPayload,
    @Body() dto: CreateLeaveRequestDto,
  ) {
    assertStaffSelfPermission(user, LEAVE_APPLY);
    const data = await this.leaveService.create(user.sub, dto, user.username);
    return createApiResponse(data, HttpStatus.CREATED, 'Leave request submitted successfully');
  }

  @Get('me')
  async listMine(@CurrentUser() user: IJwtStaffPayload) {
    assertStaffSelfPermission(user, LEAVE_APPLY);
    const data = await this.leaveService.listMine(user.sub);
    return createApiResponse(data, HttpStatus.OK, 'Leave requests retrieved successfully');
  }

  @Get('me/context')
  async getContext(@CurrentUser() user: IJwtStaffPayload) {
    assertStaffSelfPermission(user, LEAVE_APPLY);
    const data = await this.leaveService.getSelfContext(user.sub);
    return createApiResponse(data, HttpStatus.OK, 'Leave context retrieved successfully');
  }

  @Delete('me/:id')
  async cancel(
    @CurrentUser() user: IJwtStaffPayload,
    @Param('id', ParseIntPipe) id: number,
  ) {
    assertStaffSelfPermission(user, LEAVE_APPLY);
    const data = await this.leaveService.cancelMine(user.sub, id);
    return createApiResponse(data, HttpStatus.OK, 'Leave request cancelled successfully');
  }
}
