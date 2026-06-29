import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { CurrentUser } from '../../../decorators/current-user.decorator';
import { createApiResponse } from '../../../utils/serializer.util';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { ListLeaveRequestsQueryDto, ReviewLeaveRequestDto } from './dto/leave-requests.dto';
import { LeaveRequestsService } from './leave-requests.service';

@ApiTags('Leave Requests (Admin)')
@ApiBearerAuth()
@Controller('hr/leaves')
@UseGuards(JwtStaffGuard)
export class LeaveRequestsController {
  constructor(private readonly leaveService: LeaveRequestsService) {}

  @Get()
  async list(
    @Query() query: ListLeaveRequestsQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.leaveService.listForReview(query, user);
    return createApiResponse(data, HttpStatus.OK, 'Leave requests retrieved successfully');
  }

  @Get(':id')
  async getOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.leaveService.getById(id, user);
    return createApiResponse(data, HttpStatus.OK, 'Leave request retrieved successfully');
  }

  @Patch(':id/review')
  async review(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReviewLeaveRequestDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.leaveService.review(id, dto, user);
    return createApiResponse(data, HttpStatus.OK, 'Leave request reviewed successfully');
  }
}
