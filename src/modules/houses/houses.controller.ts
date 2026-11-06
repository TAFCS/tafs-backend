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
import { HousesService } from './houses.service';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { RequireAction, RequireAnyTile } from '../../decorators/require-action.decorator';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';
import { CreateHouseDto } from './dto/create-house.dto';
import { UpdateHouseDto } from './dto/update-house.dto';
import { BulkUpdateHousesDto } from './dto/bulk-update-houses.dto';
import { createApiResponse } from '../../utils/serializer.util';
import { HOUSES_MESSAGES } from '../../constants/api-response/houses.constant';

@Controller('houses')
@UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
export class HousesController {
  constructor(private readonly housesService: HousesService) {}

  // Reference data for pickers and setup: any signed-in staff member may list it.
  // Passing ?include_inactive=true shows deactivated houses (used by the Setup page).
  @Get()
  async findAll(@Query('include_inactive') includeInactive?: string) {
    const shouldInclude = includeInactive === 'true' || includeInactive === '1';
    const houses = await this.housesService.findAll({
      includeInactive: shouldInclude,
    });
    return createApiResponse(
      houses,
      HttpStatus.OK,
      HOUSES_MESSAGES.LIST_SUCCESS,
    );
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @CheckPolicies((ability) => ability.can(Action.Create, 'House'))
  @RequireAction('school-setup.houses#create')
  async create(@Body() dto: CreateHouseDto, @Req() req: Request) {
    const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
    const house = await this.housesService.create(dto, changedBy);
    return createApiResponse(
      house,
      HttpStatus.CREATED,
      HOUSES_MESSAGES.CREATE_SUCCESS,
    );
  }

  @Patch('bulk')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Update, 'House'))
  @RequireAction('school-setup.houses#edit')
  async bulkUpdate(@Body() dto: BulkUpdateHousesDto, @Req() req: Request) {
    const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
    const updated = await this.housesService.bulkUpdate(dto, changedBy);
    return createApiResponse(
      updated,
      HttpStatus.OK,
      HOUSES_MESSAGES.BULK_UPDATE_SUCCESS,
    );
  }

  @Get(':id/dependencies')
  @RequireAnyTile('school-setup.houses')
  async getDependencies(@Param('id', ParseIntPipe) id: number) {
    return this.housesService.getDependencies(id);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Update, 'House'))
  @RequireAction('school-setup.houses#edit')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateHouseDto,
    @Req() req: Request,
  ) {
    const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
    const updated = await this.housesService.update(id, dto, changedBy);
    return createApiResponse(
      updated,
      HttpStatus.OK,
      HOUSES_MESSAGES.UPDATE_SUCCESS,
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Delete, 'House'))
  @RequireAction('school-setup.houses#delete')
  async delete(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
    await this.housesService.delete(id, changedBy);
    return createApiResponse(
      null,
      HttpStatus.OK,
      HOUSES_MESSAGES.DELETE_SUCCESS,
    );
  }
}
