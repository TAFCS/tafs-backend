import { Controller, Get, HttpStatus, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../../common/guards/policies.guard';
import { CheckPolicies } from '../../../decorators/check-policies.decorator';
import { CurrentUser } from '../../../decorators/current-user.decorator';
import { Action } from '../../auth/casl/actions';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { createApiResponse } from '../../../utils/serializer.util';
import { ListLoansQueryDto } from './dto/employee-loans.dto';
import { EmployeeLoansService } from './employee-loans.service';

@ApiTags('HR Employee Loans')
@ApiBearerAuth()
@Controller('hr/employee-loans')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class EmployeeLoansListController {
  constructor(private readonly employeeLoans: EmployeeLoansService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Employee'))
  async list(
    @Query() query: ListLoansQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.employeeLoans.listOpen(user, query.status);
    return createApiResponse(data, HttpStatus.OK, 'Loans retrieved successfully');
  }
}
