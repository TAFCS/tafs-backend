import { Controller, Get, HttpStatus, Param, ParseIntPipe, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { CurrentUser } from '../../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { createApiResponse } from '../../../utils/serializer.util';
import { PayrollService } from './payroll.service';

@ApiTags('HR Payroll Self')
@ApiBearerAuth()
@Controller('hr/payroll')
@UseGuards(JwtStaffGuard)
export class PayrollSelfController {
  constructor(private readonly payrollService: PayrollService) {}

  @Get('me')
  async listMine(@CurrentUser() user: IJwtStaffPayload) {
    const data = await this.payrollService.listMyPayrollLines(user.sub);
    return createApiResponse(data, HttpStatus.OK, 'Payroll lines retrieved successfully');
  }

  @Get('me/:payrollRunId')
  async getMineDetail(
    @CurrentUser() user: IJwtStaffPayload,
    @Param('payrollRunId', ParseIntPipe) payrollRunId: number,
  ) {
    const data = await this.payrollService.getMyPayrollDetail(user.sub, payrollRunId);
    return createApiResponse(data, HttpStatus.OK, 'Payroll line detail retrieved successfully');
  }
}
