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
import { createApiResponse } from '../../utils/serializer.util';
import {
  CreatePostdatedChequeDto,
  PostdatedChequesService,
  UpdateStatusDto,
} from './postdated-cheques.service';
import { ListPostdatedChequesQueryDto } from './dto/list-postdated-cheques.dto';

@ApiTags('postdated-cheques')
@Controller('postdated-cheques')
@UseGuards(JwtStaffGuard)
export class PostdatedChequesController {
  constructor(private readonly svc: PostdatedChequesService) {}

  @Post()
  @ApiOperation({ summary: 'Record a new post-dated cheque' })
  async create(@Body() dto: CreatePostdatedChequeDto, @Req() req: Request) {
    const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
    return createApiResponse(await this.svc.create(dto, changedBy), HttpStatus.CREATED, 'Cheque recorded');
  }

  @Get('alerts')
  @ApiOperation({ summary: 'Get pending cheques due for cashing (Home page alert)' })
  async getAlerts() {
    return createApiResponse(await this.svc.getDue(), HttpStatus.OK, 'Cheque alerts retrieved');
  }

  @Get()
  @ApiOperation({ summary: 'List all cheques with optional filters' })
  async list(@Query() query: ListPostdatedChequesQueryDto) {
    return createApiResponse(
      await this.svc.list({
        status: query.status,
        student_id: query.student_id,
        campus_id: query.campus_id,
        from_date: query.from_date,
        to_date: query.to_date,
      }),
      HttpStatus.OK,
      'Cheques retrieved',
    );
  }

  @Get('due')
  @ApiOperation({ summary: 'Get all pending cheques due today or overdue' })
  async getDue() {
    return createApiResponse(await this.svc.getDue(), HttpStatus.OK, 'Due cheques retrieved');
  }

  @Get('student/:cc')
  @ApiOperation({ summary: 'Get all cheques for a specific student' })
  async getByStudent(@Param('cc', ParseIntPipe) cc: number) {
    return createApiResponse(
      await this.svc.getByStudent(cc),
      HttpStatus.OK,
      'Student cheques retrieved',
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single cheque by ID' })
  async findOne(@Param('id', ParseIntPipe) id: number) {
    return createApiResponse(await this.svc.findOne(id), HttpStatus.OK, 'Cheque retrieved');
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Update cheque status (CASHED, BOUNCED, RETURNED, CANCELLED)' })
  async updateStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateStatusDto,
    @Req() req: Request,
  ) {
    const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
    return createApiResponse(
      await this.svc.updateStatus(id, dto, changedBy),
      HttpStatus.OK,
      'Status updated',
    );
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a cheque record' })
  async remove(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
    await this.svc.remove(id, changedBy);
    return createApiResponse(null, HttpStatus.OK, 'Cheque deleted');
  }
}
