import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ClassesService } from './classes.service';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { ScopeService } from '../../common/scope/scope.service';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { RequireAction } from '../../decorators/require-action.decorator';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';
import { BulkUpdateClassesDto } from './dto/bulk-update-classes.dto';
import { CreateClassDto } from './dto/create-class.dto';

@Controller('classes')
@UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
export class ClassesController {
  constructor(
    private readonly classesService: ClassesService,
    private readonly scope: ScopeService,
  ) {}

  // Reference data for pickers: any signed-in staff member may list it,
  // trimmed to their scope. Gating it on a capability broke every page for
  // users granted tiles without that capability.
  @Get()
  async findAll(@CurrentUser() user: IJwtStaffPayload) {
    const scope = this.scope.scopeOf(user);
    const classes = await this.classesService.findAll({
      ...(scope.classes.length > 0 ? { id: { in: scope.classes } } : {}),
      ...(scope.segments.length > 0 ? { segment_id: { in: scope.segments } } : {}),
    });
    return {
      success: true,
      message: 'Classes list retrieved successfully',
      data: classes,
    };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @CheckPolicies((ability) => ability.can(Action.Create, 'Class'))
  @RequireAction('school-setup.classes#create')
  async create(@Body() dto: CreateClassDto, @Req() req: Request) {
    const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
    const created = await this.classesService.create(dto, changedBy);
    return {
      success: true,
      message: 'Class created successfully',
      data: created,
    };
  }

  @Patch('bulk')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Update, 'Class'))
  @RequireAction('school-setup.classes#edit')
  async bulkUpdate(@Body() dto: BulkUpdateClassesDto, @Req() req: Request) {
    const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
    const updated = await this.classesService.bulkUpdate(dto, changedBy);
    return {
      success: true,
      message: 'Classes updated successfully',
      data: updated,
    };
  }

  @Get(':id/dependencies')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Class'))
  async getDependencies(@Param('id', ParseIntPipe) id: number) {
    return this.classesService.getDependencies(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @CheckPolicies((ability) => ability.can(Action.Delete, 'Class'))
  @RequireAction('school-setup.classes#delete')
  async delete(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    const changedBy = (req.user as any)?.username || (req.user as any)?.id || 'system';
    await this.classesService.delete(id, changedBy);
    return {
      success: true,
      message: 'Class deleted successfully',
    };
  }
}
