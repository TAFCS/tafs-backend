import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SectionsService } from './sections.service';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';
import { BulkUpdateSectionsDto } from './dto/bulk-update-sections.dto';
import { CreateSectionDto } from './dto/create-section.dto';
import { UpdateSectionDto } from './dto/update-section.dto';

@Controller('sections')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class SectionsController {
  constructor(private readonly sectionsService: SectionsService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Section'))
  async findAll() {
    const sections = await this.sectionsService.findAll();
    return {
      success: true,
      message: 'Sections list retrieved successfully',
      data: sections,
    };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @CheckPolicies((ability) => ability.can(Action.Create, 'Section'))
  async create(@Body() dto: CreateSectionDto) {
    const section = await this.sectionsService.create(dto);
    return {
      success: true,
      message: 'Section created successfully',
      data: section,
    };
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Update, 'Section'))
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateSectionDto,
  ) {
    const section = await this.sectionsService.update(id, dto);
    return {
      success: true,
      message: 'Section updated successfully',
      data: section,
    };
  }

  @Patch('bulk')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Update, 'Section'))
  async bulkUpdate(@Body() dto: BulkUpdateSectionsDto) {
    const updated = await this.sectionsService.bulkUpdate(dto);
    return {
      success: true,
      message: 'Sections updated successfully',
      data: updated,
    };
  }
}

