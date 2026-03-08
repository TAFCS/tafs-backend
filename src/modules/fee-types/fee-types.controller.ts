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
  UseGuards,
} from '@nestjs/common';
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
  async create(@Body() dto: CreateFeeTypeDto) {
    const feeType = await this.feeTypesService.create(dto);
    return createApiResponse(
      feeType,
      HttpStatus.CREATED,
      FEE_TYPES_MESSAGES.CREATE_SUCCESS,
    );
  }

  @Patch('bulk')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Update, 'Fee'))
  async bulkUpdate(@Body() dto: BulkUpdateFeeTypesDto) {
    const updated = await this.feeTypesService.bulkUpdate(dto);
    return createApiResponse(
      updated,
      HttpStatus.OK,
      FEE_TYPES_MESSAGES.BULK_UPDATE_SUCCESS,
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Delete, 'Fee'))
  async delete(@Param('id', ParseIntPipe) id: number) {
    await this.feeTypesService.delete(id);
    return createApiResponse(
      null,
      HttpStatus.OK,
      FEE_TYPES_MESSAGES.DELETE_SUCCESS,
    );
  }
}

