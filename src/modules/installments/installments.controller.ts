import { Controller, Post, Get, Patch, Delete, Body, Param, Query, ParseIntPipe, UseGuards } from '@nestjs/common';
import { InstallmentsService } from './installments.service';
import { CreateInstallmentDto } from './dto/create-installment.dto';
import { UpdateInstallmentDto } from './dto/update-installment.dto';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { RequireAction } from '../../decorators/require-action.decorator';
import { AppAbility } from '../auth/casl/casl-ability.factory';
import { Action } from '../auth/casl/actions';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';

/**
 * Installment plans are only reachable from /studentwise-fees, so they carry
 * that tile's sub-permissions: reading a plan rides on `view`, every write on
 * `installment.manage`.
 */
@Controller('installments')
@UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
export class InstallmentsController {
  constructor(private readonly installmentsService: InstallmentsService) {}

  @Post()
  @CheckPolicies((ability: AppAbility) => ability.can(Action.Create, 'Fee'))
  @RequireAction('finance.student_overrides#installment.manage')
  async create(@Body() dto: CreateInstallmentDto, @CurrentUser() user: IJwtStaffPayload) {
    return this.installmentsService.create(dto, user.username, user);
  }

  @Get('student/:studentId')
  @CheckPolicies((ability: AppAbility) => ability.can(Action.Read, 'Fee'))
  @RequireAction('finance.student_overrides#view')
  async findByStudent(
    @Param('studentId', ParseIntPipe) studentId: number,
    @CurrentUser() user: IJwtStaffPayload,
    @Query('academic_year') academicYear?: string,
  ) {
    return this.installmentsService.findByStudent(studentId, user, academicYear);
  }

  @Patch(':id')
  @CheckPolicies((ability: AppAbility) => ability.can(Action.Update, 'Fee'))
  @RequireAction('finance.student_overrides#installment.manage')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateInstallmentDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    return this.installmentsService.update(id, dto, user.username, user);
  }

  @Delete(':id/heads/:headId')
  @CheckPolicies((ability: AppAbility) => ability.can(Action.Delete, 'Fee'))
  @RequireAction('finance.student_overrides#installment.manage')
  async removeHead(
    @Param('id', ParseIntPipe) id: number,
    @Param('headId', ParseIntPipe) headId: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    return this.installmentsService.removeHead(id, headId, user.username, user);
  }

  @Delete(':id')
  @CheckPolicies((ability: AppAbility) => ability.can(Action.Delete, 'Fee'))
  @RequireAction('finance.student_overrides#installment.manage')
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) {
    return this.installmentsService.remove(id, user.username, user);
  }
}
