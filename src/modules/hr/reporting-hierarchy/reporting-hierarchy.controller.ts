import { Body, Controller, Get, HttpStatus, Param, ParseIntPipe, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { CurrentUser } from '../../../decorators/current-user.decorator';
import { createApiResponse } from '../../../utils/serializer.util';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { SetManagersDto } from './dto/set-managers.dto';
import { ReportingHierarchyService } from './reporting-hierarchy.service';

// SUPER_ADMIN only, enforced in the service by role. There is deliberately no
// @RequireAction here: the tile is superAdminOnly and has no actions to grant.
@ApiTags('Reporting Hierarchy')
@ApiBearerAuth()
@Controller('hr/reporting-hierarchy')
@UseGuards(JwtStaffGuard)
export class ReportingHierarchyController {
  constructor(private readonly service: ReportingHierarchyService) {}

  @Get()
  async getTree(@CurrentUser() user: IJwtStaffPayload) {
    const data = await this.service.getTree(user);
    return createApiResponse(data, HttpStatus.OK, 'Reporting hierarchy retrieved successfully');
  }

  @Put(':employeeId/managers')
  async setManagers(
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Body() dto: SetManagersDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.service.setManagers(employeeId, dto, user);
    return createApiResponse(data, HttpStatus.OK, 'Reporting lines saved');
  }
}
