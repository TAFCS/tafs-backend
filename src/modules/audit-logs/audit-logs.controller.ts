import {
  Controller,
  Get,
  Query,
  UseGuards,
  HttpStatus,
} from '@nestjs/common';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { AuditLogsGuard } from './guards/audit-logs.guard';
import { QueryAuditLogsDto } from './dto/query-audit-logs.dto';
import { AuditLogsService } from './audit-logs.service';
import { createApiResponse } from '../../utils/serializer.util';

@Controller('audit-logs')
@UseGuards(JwtStaffGuard, AuditLogsGuard)
export class AuditLogsController {
  constructor(private readonly auditLogsService: AuditLogsService) {}

  @Get()
  async findAll(@Query() query: QueryAuditLogsDto) {
    const result = await this.auditLogsService.findAll(query);
    return createApiResponse(
      result,
      HttpStatus.OK,
      'Audit logs retrieved successfully',
    );
  }
}
