import { Controller, Get, Post, Body, Param, ParseIntPipe, HttpStatus, Query } from '@nestjs/common';
import { TransferService } from './transfer.service';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { createApiResponse } from '../../utils/serializer.util';

@ApiTags('transfers')
@Controller('transfers')
export class TransferController {
  constructor(private readonly transferService: TransferService) {}

  @Get(':cc/classes')
  @ApiOperation({ summary: 'Get available classes for the target-class picker based on student mappings' })
  async getClasses(@Param('cc', ParseIntPipe) cc: number) {
    const data = await this.transferService.getAvailableClasses(cc);
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

  @Post(':cc/generate-pdf')
  @ApiOperation({ summary: 'Generate and upload Transfer Order PDF, returns CDN URL' })
  async generatePdf(
    @Param('cc', ParseIntPipe) cc: number,
    @Body() body: { transfer_from?: string; transfer_to?: string; discipline?: string; remarks?: string; date_of_transfer?: string },
  ) {
    const result = await this.transferService.generateTransferPdf(cc, body);
    return createApiResponse(result, HttpStatus.OK, 'Transfer order PDF generated successfully');
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
