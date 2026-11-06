import {
  Controller,
  Get,
  HttpStatus,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { createApiResponse } from '../../utils/serializer.util';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { RequireAction } from '../../decorators/require-action.decorator';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';
import { StudentReportsService } from './student-reports.service';
import { MovementReportService } from './movement-report.service';
import {
  ExportMovementQueryDto,
  MovementCellQueryDto,
  MovementQueryDto,
} from './dto/movement-query.dto';
import {
  ExportStudentCategoriesQueryDto,
  ExportStudentStrengthQueryDto,
  StudentStrengthCellQueryDto,
  StudentStrengthQueryDto,
} from './dto/student-strength-query.dto';

/**
 * TAFSD-451: Student Reports. Same access as the Student Directory: viewing
 * needs `student.directory#view`, the download `#export`, and every count is
 * limited to the caller's student scope.
 */
@Controller('student-reports')
@UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
export class StudentReportsController {
  constructor(
    private readonly reports: StudentReportsService,
    private readonly movementReport: MovementReportService,
  ) {}

  @Get('strength')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Student'))
  @RequireAction('student.directory#view')
  async strength(
    @Query() query: StudentStrengthQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    return createApiResponse(
      await this.reports.strength(query, user),
      HttpStatus.OK,
      'Student strength retrieved',
    );
  }

  @Get('strength/students')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Student'))
  @RequireAction('student.directory#view')
  async strengthStudents(
    @Query() query: StudentStrengthCellQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    return createApiResponse(
      await this.reports.cellStudents(query, user),
      HttpStatus.OK,
      'Students retrieved',
    );
  }

  @Get('strength/export')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Student'))
  @RequireAction('student.directory#export')
  async exportStrength(
    @Query() query: ExportStudentStrengthQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
    @Res() res: Response,
  ) {
    const file = await this.reports.exportStrength(query, user);
    res.set({
      'Content-Type': file.contentType,
      'Content-Disposition': `attachment; filename="${file.filename}"`,
      'Content-Length': file.buffer.length,
    });
    res.send(file.buffer);
  }

  /** TAFSD-452: Special Categories reads through `strength` and `strength/students` with its filters; only the file differs. */
  @Get('categories/export')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Student'))
  @RequireAction('student.directory#export')
  async exportCategories(
    @Query() query: ExportStudentCategoriesQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
    @Res() res: Response,
  ) {
    const file = await this.reports.exportCategories(query, user);
    res.set({
      'Content-Type': file.contentType,
      'Content-Disposition': `attachment; filename="${file.filename}"`,
      'Content-Length': file.buffer.length,
    });
    res.send(file.buffer);
  }

  /** TAFSD-453: Admissions and Withdrawals (report C). */
  @Get('movement')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Student'))
  @RequireAction('student.directory#view')
  async movement(
    @Query() query: MovementQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    return createApiResponse(
      await this.movementReport.movement(query, user),
      HttpStatus.OK,
      'Admissions and withdrawals retrieved',
    );
  }

  @Get('movement/students')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Student'))
  @RequireAction('student.directory#view')
  async movementStudents(
    @Query() query: MovementCellQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    return createApiResponse(
      await this.movementReport.cellStudents(query, user),
      HttpStatus.OK,
      'Students retrieved',
    );
  }

  @Get('movement/export')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Student'))
  @RequireAction('student.directory#export')
  async exportMovement(
    @Query() query: ExportMovementQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
    @Res() res: Response,
  ) {
    const file = await this.movementReport.export(query, user);
    res.set({
      'Content-Type': file.contentType,
      'Content-Disposition': `attachment; filename="${file.filename}"`,
      'Content-Length': file.buffer.length,
    });
    res.send(file.buffer);
  }
}
