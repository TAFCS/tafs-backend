import {
  Controller,
  Get,
  Query,
  Request,
  UseGuards,
  HttpStatus,
} from '@nestjs/common';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { RequireAnyAction } from '../../decorators/require-action.decorator';
import { AuditLogsGuard } from './guards/audit-logs.guard';
import { QueryAuditLogsDto } from './dto/query-audit-logs.dto';
import { AuditLogsService } from './audit-logs.service';
import { createApiResponse } from '../../utils/serializer.util';

@Controller('audit-logs')
@UseGuards(JwtStaffGuard, AuditLogsGuard, TileActionGuard)
export class AuditLogsController {
  constructor(private readonly auditLogsService: AuditLogsService) {}

  // Shared with the Student Directory's timeline (?student_id). AuditLogsGuard
  // still confines a directory-only caller to that one student.
  @Get()
  @RequireAnyAction('system.activity_logs#view', 'student.directory#view')
  async findAll(@Query() query: QueryAuditLogsDto, @Request() req: any) {
    const result = await this.auditLogsService.findAll(query, req.user);
    return createApiResponse(
      result,
      HttpStatus.OK,
      'Audit logs retrieved successfully',
    );
  }
}
