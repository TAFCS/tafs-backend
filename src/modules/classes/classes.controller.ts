import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ClassesService } from './classes.service';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';
import { BulkUpdateClassesDto } from './dto/bulk-update-classes.dto';
import { CreateClassDto } from './dto/create-class.dto';

@Controller('classes')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class ClassesController {
  constructor(private readonly classesService: ClassesService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Class'))
  async findAll() {
    const classes = await this.classesService.findAll();
    return {
      success: true,
      message: 'Classes list retrieved successfully',
      data: classes,
    };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @CheckPolicies((ability) => ability.can(Action.Create, 'Class'))
  async create(@Body() dto: CreateClassDto) {
    const created = await this.classesService.create(dto);
    return {
      success: true,
      message: 'Class created successfully',
      data: created,
    };
  }

  @Patch('bulk')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Update, 'Class'))
  async bulkUpdate(@Body() dto: BulkUpdateClassesDto) {
    const updated = await this.classesService.bulkUpdate(dto);
    return {
      success: true,
      message: 'Classes updated successfully',
      data: updated,
    };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Delete, 'Class'))
  async delete(@Param('id', ParseIntPipe) id: number) {
    await this.classesService.delete(id);
    return {
      success: true,
      message: 'Class deleted successfully',
    };
  }
}
