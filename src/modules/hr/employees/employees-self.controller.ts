import { Controller, Get, HttpStatus, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { CurrentUser } from '../../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { createApiResponse } from '../../../utils/serializer.util';
import { EmployeesService } from './employees.service';

@ApiTags('HR Employees Self')
@ApiBearerAuth()
@Controller('hr/employees')
@UseGuards(JwtStaffGuard)
export class EmployeesSelfController {
  constructor(private readonly employeesService: EmployeesService) {}

  @Get('me')
  async getMine(@CurrentUser() user: IJwtStaffPayload) {
    const data = await this.employeesService.getMine(user.sub);
    return createApiResponse(data, HttpStatus.OK, 'Employee profile retrieved successfully');
  }
}
