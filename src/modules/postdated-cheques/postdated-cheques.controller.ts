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
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PostdatedChequeStatus } from '@prisma/client';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { createApiResponse } from '../../utils/serializer.util';
import {
  CreatePostdatedChequeDto,
  PostdatedChequesService,
  UpdateStatusDto,
} from './postdated-cheques.service';

@ApiTags('postdated-cheques')
@Controller('postdated-cheques')
@UseGuards(JwtStaffGuard)
export class PostdatedChequesController {
  constructor(private readonly svc: PostdatedChequesService) {}

  @Post()
  @ApiOperation({ summary: 'Record a new post-dated cheque' })
  async create(@Body() dto: CreatePostdatedChequeDto) {
    return createApiResponse(await this.svc.create(dto), HttpStatus.CREATED, 'Cheque recorded');
  }

  @Get()
  @ApiOperation({ summary: 'List all cheques with optional filters' })
  async list(
    @Query('status') status?: PostdatedChequeStatus,
    @Query('student_id') studentId?: string,
    @Query('campus_id') campusId?: string,
    @Query('from_date') fromDate?: string,
    @Query('to_date') toDate?: string,
  ) {
    return createApiResponse(
      await this.svc.list({
        status,
        student_id: studentId ? parseInt(studentId, 10) : undefined,
        campus_id: campusId ? parseInt(campusId, 10) : undefined,
        from_date: fromDate,
        to_date: toDate,
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
  ) {
    return createApiResponse(
      await this.svc.updateStatus(id, dto),
      HttpStatus.OK,
      'Status updated',
    );
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a cheque record' })
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.svc.remove(id);
    return createApiResponse(null, HttpStatus.OK, 'Cheque deleted');
  }
}
