import { Body, Controller, Get, HttpStatus, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../../common/guards/policies.guard';
import { TileActionGuard } from '../../../common/guards/tile-action.guard';
import { CheckPolicies } from '../../../decorators/check-policies.decorator';
import { CurrentUser } from '../../../decorators/current-user.decorator';
import { RequireAction } from '../../../decorators/require-action.decorator';
import { Action } from '../../auth/casl/actions';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { BulkMarkInstallmentsCollectedDto } from '../security-deposits/dto/security-deposits.dto';
import { createApiResponse } from '../../../utils/serializer.util';
import { ListLoansQueryDto } from './dto/employee-loans.dto';
import { EmployeeLoansService } from './employee-loans.service';

@ApiTags('HR Employee Loans')
@ApiBearerAuth()
@Controller('hr/employee-loans')
@UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
export class EmployeeLoansListController {
  constructor(private readonly employeeLoans: EmployeeLoansService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Employee'))
  @RequireAction('hr.employee_loans#view')
  async list(
    @Query() query: ListLoansQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.employeeLoans.listOpen(user, query.status);
    return createApiResponse(data, HttpStatus.OK, 'Loans retrieved successfully');
  }

  /** TAFSD-589: mark one cycle's installment collected outside payroll for several employees. */
  @Post('mark-collected')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  @RequireAction('hr.employee_loans#mark_collected')
  async markCollectedBulk(
    @Body() dto: BulkMarkInstallmentsCollectedDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.employeeLoans.markCollectedBulk(dto, user);
    return createApiResponse(data, HttpStatus.OK, 'Installments marked collected');
  }
}
