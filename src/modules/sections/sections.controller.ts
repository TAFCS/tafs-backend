import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SectionsService } from './sections.service';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';
import { CreateSectionDto } from './dto/create-section.dto';
import { BulkUpdateSectionsDto } from './dto/bulk-update-sections.dto';
import { createApiResponse } from '../../utils/serializer.util';
import { SECTIONS_MESSAGES } from '../../constants/api-response/sections.constant';

@Controller('sections')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class SectionsController {
  constructor(private readonly sectionsService: SectionsService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Section'))
  async findAll() {
    const sections = await this.sectionsService.findAll();
    return createApiResponse(
      sections,
      HttpStatus.OK,
      SECTIONS_MESSAGES.LIST_SUCCESS,
    );
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @CheckPolicies((ability) => ability.can(Action.Create, 'Section'))
  async create(@Body() dto: CreateSectionDto) {
    const section = await this.sectionsService.create(dto);
    return createApiResponse(
      section,
      HttpStatus.CREATED,
      SECTIONS_MESSAGES.CREATE_SUCCESS,
    );
  }

  @Patch('bulk')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Update, 'Section'))
  async bulkUpdate(@Body() dto: BulkUpdateSectionsDto) {
    const updated = await this.sectionsService.bulkUpdate(dto);
    return createApiResponse(
      updated,
      HttpStatus.OK,
      SECTIONS_MESSAGES.BULK_UPDATE_SUCCESS,
    );
  }
}

