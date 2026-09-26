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
import { SectionsService } from './sections.service';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { ScopeService } from '../../common/scope/scope.service';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { RequireAction } from '../../decorators/require-action.decorator';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';
import { CreateSectionDto } from './dto/create-section.dto';
import { BulkUpdateSectionsDto } from './dto/bulk-update-sections.dto';
import { createApiResponse } from '../../utils/serializer.util';
import { SECTIONS_MESSAGES } from '../../constants/api-response/sections.constant';

@Controller('sections')
@UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
export class SectionsController {
  constructor(
    private readonly sectionsService: SectionsService,
    private readonly scope: ScopeService,
  ) {}

  // Reference data for pickers: any signed-in staff member may list it,
  // trimmed to their scope. Gating it on a capability broke every page for
  // users granted tiles without that capability.
  @Get()
  async findAll(@CurrentUser() user: IJwtStaffPayload) {
    const { sections: scoped } = this.scope.scopeOf(user);
    const sections = await this.sectionsService.findAll(
      scoped.length > 0 ? { id: { in: scoped } } : undefined,
    );
    return createApiResponse(
      sections,
      HttpStatus.OK,
      SECTIONS_MESSAGES.LIST_SUCCESS,
    );
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @CheckPolicies((ability) => ability.can(Action.Create, 'Section'))
  @RequireAction('school-setup.sections#create')
  async create(@Body() dto: CreateSectionDto, @Req() req: Request) {
    const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
    const section = await this.sectionsService.create(dto, changedBy);
    return createApiResponse(
      section,
      HttpStatus.CREATED,
      SECTIONS_MESSAGES.CREATE_SUCCESS,
    );
  }

  @Patch('bulk')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Update, 'Section'))
  @RequireAction('school-setup.sections#edit')
  async bulkUpdate(@Body() dto: BulkUpdateSectionsDto, @Req() req: Request) {
    const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
    const updated = await this.sectionsService.bulkUpdate(dto, changedBy);
    return createApiResponse(
      updated,
      HttpStatus.OK,
      SECTIONS_MESSAGES.BULK_UPDATE_SUCCESS,
    );
  }

  @Get(':id/dependencies')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Section'))
  async getDependencies(@Param('id', ParseIntPipe) id: number) {
    return this.sectionsService.getDependencies(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Delete, 'Section'))
  @RequireAction('school-setup.sections#delete')
  async delete(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
    await this.sectionsService.delete(id, changedBy);
    return createApiResponse(
      null,
      HttpStatus.OK,
      SECTIONS_MESSAGES.DELETE_SUCCESS,
    );
  }
}

