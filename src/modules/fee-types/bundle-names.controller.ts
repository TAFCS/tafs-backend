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
  Query,
  UseGuards,
} from '@nestjs/common';
import { BundleNamesService } from './bundle-names.service';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';
import { CreateBundleNameDto, UpdateBundleNameDto } from './dto/bundle-names.dto';
import { createApiResponse } from '../../utils/serializer.util';

@Controller('fee-types/bundle-names')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class BundleNamesController {
  constructor(private readonly bundleNamesService: BundleNamesService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Fee'))
  async findAll(@Query('activeOnly') activeOnly?: string) {
    const names = await this.bundleNamesService.findAll(activeOnly === 'true');
    return createApiResponse(names, HttpStatus.OK, 'Bundle names retrieved successfully');
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @CheckPolicies((ability) => ability.can(Action.Create, 'Fee'))
  async create(@Body() dto: CreateBundleNameDto) {
    const name = await this.bundleNamesService.create(dto);
    return createApiResponse(name, HttpStatus.CREATED, 'Bundle name created successfully');
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Update, 'Fee'))
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateBundleNameDto,
  ) {
    const updated = await this.bundleNamesService.update(id, dto);
    return createApiResponse(updated, HttpStatus.OK, 'Bundle name updated successfully');
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Delete, 'Fee'))
  async delete(@Param('id', ParseIntPipe) id: number) {
    await this.bundleNamesService.delete(id);
    return createApiResponse(null, HttpStatus.OK, 'Bundle name deactivated successfully');
  }
}
