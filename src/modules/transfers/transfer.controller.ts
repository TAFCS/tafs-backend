import { Controller, Get, Post, Body, Param, ParseIntPipe, HttpStatus, Query } from '@nestjs/common';
import { TransferService } from './transfer.service';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { createApiResponse } from '../../utils/serializer.util';

@ApiTags('transfers')
@Controller('transfers')
export class TransferController {
  constructor(private readonly transferService: TransferService) {}

  @Get('classes')
  @ApiOperation({ summary: 'Get all classes for the target-class picker' })
  async getClasses() {
    const data = await this.transferService.getAvailableClasses();
    return createApiResponse(data, HttpStatus.OK, 'Classes retrieved successfully');
  }

  @Post(':cc/execute')
  @ApiOperation({ summary: 'Execute a student transfer to a new class/academic system' })
  async executeTransfer(
    @Param('cc', ParseIntPipe) cc: number,
    @Body() body: { to_class_id: number; discipline?: string; remarks?: string },
  ) {
    const data = await this.transferService.executeTransfer(cc, body);
    return createApiResponse(data, HttpStatus.OK, 'Transfer executed successfully');
  }

  @Get('search')
  @ApiOperation({ summary: 'Search students for transfer by name or CC' })
  async search(@Query('q') q: string) {
    const data = await this.transferService.searchStudents(q || '');
    return createApiResponse(
      data,
      HttpStatus.OK,
      'Transfer student search results retrieved successfully',
    );
  }

  @Get(':cc/transfer-order')
  @ApiOperation({ summary: 'Get student data for transfer order PDF' })
  async getTransferOrder(@Param('cc', ParseIntPipe) cc: number) {
    const data = await this.transferService.getTransferOrderData(cc);
    return createApiResponse(
      data,
      HttpStatus.OK,
      'Transfer order data retrieved successfully',
    );
  }
}
