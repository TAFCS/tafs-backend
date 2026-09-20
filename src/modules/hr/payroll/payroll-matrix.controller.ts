import { Controller, Get, HttpStatus, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../../common/guards/policies.guard';
import { TileActionGuard } from '../../../common/guards/tile-action.guard';
import { CheckPolicies } from '../../../decorators/check-policies.decorator';
import { RequireAnyAction } from '../../../decorators/require-action.decorator';
import { CurrentUser } from '../../../decorators/current-user.decorator';
import { Action } from '../../auth/casl/actions';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { createApiResponse } from '../../../utils/serializer.util';
import { PayrollService } from './payroll.service';
import { AttendanceMatrixQueryDto } from './dto/payroll.dto';

@ApiTags('HR Payroll')
@ApiBearerAuth()
@Controller('hr/payroll')
@UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
export class PayrollMatrixController {
  constructor(private readonly payrollService: PayrollService) {}

  @Get('attendance-matrix')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Payroll'))
  @RequireAnyAction('attendance.employee_attendance_cycle#view', 'hr.payroll#view')
  async getAttendanceMatrix(@Query() query: AttendanceMatrixQueryDto, @CurrentUser() user: IJwtStaffPayload) {
    const data = await this.payrollService.getAttendanceMatrix(query, user);
    return createApiResponse(data, HttpStatus.OK, 'Attendance matrix retrieved successfully');
  }

  @Get('attendance-matrix/export')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Payroll'))
  @RequireAnyAction('attendance.employee_attendance_cycle#export', 'hr.payroll#export')
  async exportAttendanceMatrix(
    @Query() query: AttendanceMatrixQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
    @Res() res: Response,
  ) {
    const buffer = await this.payrollService.exportAttendanceMatrix(query, user);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="attendance-${query.period_start}-to-${query.period_end}.xlsx"`,
      'Content-Length': buffer.length,
    });
    res.send(buffer);
  }
}

