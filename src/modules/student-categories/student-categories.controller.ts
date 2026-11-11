import {
  Body,
  Controller,
  Delete,
  Get,
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
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { RequireAction } from '../../decorators/require-action.decorator';
import { createApiResponse } from '../../utils/serializer.util';
import { Action } from '../auth/casl/actions';
import {
  CreateStudentCategoryDto,
  UpdateStudentCategoryDto,
} from './dto/student-category.dto';
import { StudentCategoriesService } from './student-categories.service';

// The GET is undecorated on purpose: the student form, Studentwise Fees and the
// student reports all read the list to show and filter categories. Only the
// writes are gated, on the School Setup tile.
@ApiTags('Student Categories')
@Controller('student-categories')
@UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
export class StudentCategoriesController {
  constructor(private readonly service: StudentCategoriesService) {}

  private by(req: Request) {
    const u = req.user as any;
    return u?.username || u?.id || 'system';
  }

  @Get()
  @ApiOperation({ summary: 'Special categories, with how many students hold each' })
  async findAll(@Query('include_retired') includeRetired?: string) {
    const rows = await this.service.findAll(includeRetired !== 'false');
    return createApiResponse(rows, HttpStatus.OK, 'Categories fetched');
  }

  @Post()
  @ApiOperation({ summary: 'Add a special category' })
  @CheckPolicies((ability) => ability.can(Action.Update, 'Student'))
  @RequireAction('school-setup.special_categories#create')
  async create(@Body() dto: CreateStudentCategoryDto, @Req() req: Request) {
    const row = await this.service.create(dto, this.by(req));
    return createApiResponse(row, HttpStatus.CREATED, 'Category added');
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename, recolour, reorder, retire or restore a category' })
  @CheckPolicies((ability) => ability.can(Action.Update, 'Student'))
  @RequireAction('school-setup.special_categories#edit')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateStudentCategoryDto,
    @Req() req: Request,
  ) {
    const row = await this.service.update(id, dto, this.by(req));
    return createApiResponse(row, HttpStatus.OK, 'Category saved');
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a category nobody holds' })
  @CheckPolicies((ability) => ability.can(Action.Update, 'Student'))
  @RequireAction('school-setup.special_categories#delete')
  async remove(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    await this.service.remove(id, this.by(req));
    return createApiResponse(null, HttpStatus.OK, 'Category deleted');
  }
}
