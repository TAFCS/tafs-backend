import { Controller, Post, Get, Patch, Delete, Body, Param, Query, ParseIntPipe, UseGuards } from '@nestjs/common';
import { InstallmentsService } from './installments.service';
import { CreateInstallmentDto } from './dto/create-installment.dto';
import { UpdateInstallmentDto } from './dto/update-installment.dto';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { AppAbility } from '../auth/casl/casl-ability.factory';
import { Action } from '../auth/casl/actions';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';

@Controller('installments')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class InstallmentsController {
  constructor(private readonly installmentsService: InstallmentsService) {}

  @Post()
  @CheckPolicies((ability: AppAbility) => ability.can(Action.Create, 'Fee'))
  async create(@Body() dto: CreateInstallmentDto, @CurrentUser() user: IJwtStaffPayload) {
    return this.installmentsService.create(dto, user.username);
  }

  @Get('student/:studentId')
  @CheckPolicies((ability: AppAbility) => ability.can(Action.Read, 'Fee'))
  async findByStudent(
    @Param('studentId', ParseIntPipe) studentId: number,
    @Query('academic_year') academicYear?: string,
  ) {
    return this.installmentsService.findByStudent(studentId, academicYear);
  }

  @Patch(':id')
  @CheckPolicies((ability: AppAbility) => ability.can(Action.Update, 'Fee'))
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateInstallmentDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    return this.installmentsService.update(id, dto, user.username);
  }

  @Delete(':id/heads/:headId')
  @CheckPolicies((ability: AppAbility) => ability.can(Action.Delete, 'Fee'))
  async removeHead(
    @Param('id', ParseIntPipe) id: number,
    @Param('headId', ParseIntPipe) headId: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    return this.installmentsService.removeHead(id, headId, user.username);
  }

  @Delete(':id')
  @CheckPolicies((ability: AppAbility) => ability.can(Action.Delete, 'Fee'))
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) {
    return this.installmentsService.remove(id, user.username);
  }
}
