import { Controller, Post, Get, Patch, Delete, Body, Param, Query, ParseIntPipe, UseGuards, Request } from '@nestjs/common';
import { InstallmentsService } from './installments.service';
import { CreateInstallmentDto } from './dto/create-installment.dto';
import { UpdateInstallmentDto } from './dto/update-installment.dto';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { AppAbility } from '../auth/casl/casl-ability.factory';
import { Action } from '../auth/casl/actions';

@Controller('installments')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class InstallmentsController {
  constructor(private readonly installmentsService: InstallmentsService) {}

  @Post()
  @CheckPolicies((ability: AppAbility) => ability.can(Action.Create, 'Fee'))
  async create(@Body() dto: CreateInstallmentDto, @Request() req) {
    const userId = req.user.username || req.user.id;
    return this.installmentsService.create(dto, userId);
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
  ) {
    return this.installmentsService.update(id, dto);
  }

  @Delete(':id/heads/:headId')
  @CheckPolicies((ability: AppAbility) => ability.can(Action.Delete, 'Fee'))
  async removeHead(
    @Param('id', ParseIntPipe) id: number,
    @Param('headId', ParseIntPipe) headId: number,
  ) {
    return this.installmentsService.removeHead(id, headId);
  }

  @Delete(':id')
  @CheckPolicies((ability: AppAbility) => ability.can(Action.Delete, 'Fee'))
  async remove(@Param('id', ParseIntPipe) id: number) {
    return this.installmentsService.remove(id);
  }
}
