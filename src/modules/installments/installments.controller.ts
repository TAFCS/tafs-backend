import { Controller, Post, Body, UseGuards, Request } from '@nestjs/common';
import { InstallmentsService } from './installments.service';
import { CreateInstallmentDto } from './dto/create-installment.dto';
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
}
