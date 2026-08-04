import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { FeeTypesService } from './fee-types.service';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';
import { CreateFeeTypeDto } from './dto/create-fee-type.dto';
import { BulkUpdateFeeTypesDto } from './dto/bulk-update-fee-types.dto';
import { createApiResponse } from '../../utils/serializer.util';
import { FEE_TYPES_MESSAGES } from '../../constants/api-response/fee-types.constant';

@Controller('fee-types')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class FeeTypesController {
  constructor(private readonly feeTypesService: FeeTypesService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Fee'))
  async findAll() {
    const feeTypes = await this.feeTypesService.findAll();
    return createApiResponse(
      feeTypes,
      HttpStatus.OK,
      FEE_TYPES_MESSAGES.LIST_SUCCESS,
    );
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @CheckPolicies((ability) => ability.can(Action.Create, 'Fee'))
  async create(@Body() dto: CreateFeeTypeDto, @Req() req: Request) {
    const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
    const feeType = await this.feeTypesService.create(dto, changedBy);
    return createApiResponse(
      feeType,
      HttpStatus.CREATED,
      FEE_TYPES_MESSAGES.CREATE_SUCCESS,
    );
  }

  @Patch('bulk')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Update, 'Fee'))
  async bulkUpdate(@Body() dto: BulkUpdateFeeTypesDto, @Req() req: Request) {
    const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
    const updated = await this.feeTypesService.bulkUpdate(dto, changedBy);
    return createApiResponse(
      updated,
      HttpStatus.OK,
      FEE_TYPES_MESSAGES.BULK_UPDATE_SUCCESS,
    );
  }

  @Get(':id/dependencies')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Fee'))
  async getDependencies(@Param('id', ParseIntPipe) id: number) {
    return this.feeTypesService.getDependencies(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Delete, 'Fee'))
  async delete(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
    await this.feeTypesService.delete(id, changedBy);
    return createApiResponse(
      null,
      HttpStatus.OK,
      FEE_TYPES_MESSAGES.DELETE_SUCCESS,
    );
  }
}

