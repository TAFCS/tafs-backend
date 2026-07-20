import { Controller, Get, HttpStatus, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../../common/guards/policies.guard';
import { CheckPolicies } from '../../../decorators/check-policies.decorator';
import { CurrentUser } from '../../../decorators/current-user.decorator';
import { Action } from '../../auth/casl/actions';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { createApiResponse } from '../../../utils/serializer.util';
import { PayrollService } from './payroll.service';
import { AttendanceMatrixQueryDto } from './dto/payroll.dto';

@ApiTags('HR Payroll')
@ApiBearerAuth()
@Controller('hr/payroll')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class PayrollMatrixController {
  constructor(private readonly payrollService: PayrollService) {}

  @Get('attendance-matrix')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Payroll'))
  async getAttendanceMatrix(@Query() query: AttendanceMatrixQueryDto, @CurrentUser() user: IJwtStaffPayload) {
    const data = await this.payrollService.getAttendanceMatrix(query, user);
    return createApiResponse(data, HttpStatus.OK, 'Attendance matrix retrieved successfully');
  }
}
