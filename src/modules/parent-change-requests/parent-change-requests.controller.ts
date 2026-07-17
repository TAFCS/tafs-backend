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

@Controller('parent-change-requests')
export class ParentChangeRequestsController {
  constructor(private readonly service: ParentChangeRequestsService) {}

  @Post()
  @UseGuards(JwtParentGuard)
  async createRequest(@Body() dto: CreateChangeRequestDto) {
    return this.service.createRequest(dto);
  }

  @Get()
  @UseGuards(JwtStaffGuard)
  async listRequests() {
    return this.service.listRequests();
  }

  @Get(':id')
  @UseGuards(JwtStaffGuard)
  async getRequest(@Param('id', ParseIntPipe) id: number) {
    return this.service.getRequestById(id);
  }

  @Patch(':id/process')
  @UseGuards(JwtStaffGuard)
  async processRequest(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ProcessChangeRequestDto,
    @Request() req: any,
  ) {
    const adminLabel = req.user?.username || req.user?.sub || 'system';
    return this.service.processRequest(id, dto, req.user.sub, adminLabel);
  }
}
