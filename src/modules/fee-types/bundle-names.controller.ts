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
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
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
  async create(@Body() dto: CreateBundleNameDto, @Req() req: Request) {
    const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
    const name = await this.bundleNamesService.create(dto, changedBy);
    return createApiResponse(name, HttpStatus.CREATED, 'Bundle name created successfully');
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Update, 'Fee'))
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateBundleNameDto,
    @Req() req: Request,
  ) {
    const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
    const updated = await this.bundleNamesService.update(id, dto, changedBy);
    return createApiResponse(updated, HttpStatus.OK, 'Bundle name updated successfully');
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Delete, 'Fee'))
  async delete(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
    await this.bundleNamesService.delete(id, changedBy);
    return createApiResponse(null, HttpStatus.OK, 'Bundle name deactivated successfully');
  }
}
