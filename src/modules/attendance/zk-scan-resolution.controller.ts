import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsISO8601,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { StaffRole } from '@prisma/client';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { CurrentUser } from '../../decorators/current-user.decorator';
import { auditActorLabel } from '../../common/utils/audit-actor.util';
import { Action } from '../auth/casl/actions';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { createApiResponse } from '../../utils/serializer.util';
import { DevicePersonType } from '@prisma/client';
import { ResolutionScope, ZkScanResolutionService } from './zk-scan-resolution.service';
import type { PersonRef } from './device-mapping-resolution.util';

export class PreviewLinkDto {
  @IsString() device_sn: string;
  @IsString() device_pin: string;
  @IsIn(['STAFF', 'STUDENT']) person_type: 'STAFF' | 'STUDENT';
  @IsOptional() @Type(() => Number) @IsInt() employee_id?: number;
  @IsOptional() @Type(() => Number) @IsInt() student_cc?: number;
}

export class PreviewUnlinkDto {
  @IsString() device_sn: string;
  @IsString() device_pin: string;
}

export class ResolveScansDto {
  @IsIn(['scan_ids', 'device_pin', 'device', 'date_range'])
  kind: 'scan_ids' | 'device_pin' | 'device' | 'date_range';

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5000)
  @Type(() => Number)
  @IsInt({ each: true })
  scan_ids?: number[];

  @IsOptional() @IsString()
  device_sn?: string;

  @IsOptional() @IsString()
  device_pin?: string;

  @IsOptional() @IsISO8601()
  date_from?: string;

  @IsOptional() @IsISO8601()
  date_to?: string;

  /** Defaults to true — must be explicitly false to write anything. */
  @IsOptional() @IsBoolean()
  dry_run?: boolean;

  @IsOptional() @IsBoolean()
  exclude_today?: boolean;

  @IsOptional() @IsBoolean()
  force?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  max_affected_days?: number;
}

@ApiTags('Attendance Scan Resolution')
@ApiBearerAuth()
@Controller('attendance/zk-scan-resolution')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class ZkScanResolutionController {
  constructor(private readonly resolution: ZkScanResolutionService) {}

  /**
   * Rebuilds scan attribution from the current mappings. Dry-run by default —
   * omitting dry_run returns a diff and changes nothing.
   */
  @Post('resolve')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Policy'))
  async resolve(@Body() dto: ResolveScansDto, @CurrentUser() user: IJwtStaffPayload) {
    this.assertSuperAdmin(user);

    const scope = this.buildScope(dto);
    const report = await this.resolution.resolve(scope, {
      actor: auditActorLabel(user),
      dryRun: dto.dry_run !== false,
      excludeToday: dto.exclude_today,
      force: dto.force,
      maxAffectedDays: dto.max_affected_days,
    });

    return createApiResponse(
      report,
      HttpStatus.OK,
      report.dry_run
        ? 'Dry run complete — no changes were written'
        : 'Scan attribution re-resolved successfully',
    );
  }

  /**
   * "If I linked this pin to this person, what would happen?"
   *
   * Powers the confirm step on one-click mapping. A plain dry-run can't answer
   * this — an unmapped pin has nothing to resolve to, so it reports no change.
   */
  @Post('preview-link')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee') || ability.can(Action.Manage, 'Student'))
  async previewLink(@Body() dto: PreviewLinkDto, @CurrentUser() user: IJwtStaffPayload) {
    this.assertSuperAdmin(user);
    if (dto.person_type === 'STAFF' && !dto.employee_id) {
      throw new BadRequestException('employee_id is required for a STAFF preview');
    }
    if (dto.person_type === 'STUDENT' && !dto.student_cc) {
      throw new BadRequestException('student_cc is required for a STUDENT preview');
    }

    const target: PersonRef = {
      person_type: dto.person_type as DevicePersonType,
      employee_id: dto.person_type === 'STAFF' ? (dto.employee_id ?? null) : null,
      student_cc: dto.person_type === 'STUDENT' ? (dto.student_cc ?? null) : null,
    };

    const report = await this.resolution.resolve(
      { kind: 'device_pin', device_sn: dto.device_sn, device_pin: dto.device_pin },
      { actor: auditActorLabel(user), dryRun: true, overrideToPerson: target },
    );
    // The person being linked to is the subject, not a bystander — excluding them
    // keeps "affects other people" meaning what it says.
    return createApiResponse(
      await this.resolution.summariseImpact(report, target),
      HttpStatus.OK,
      'Link preview generated',
    );
  }

  /**
   * "If I unlinked/deleted this pin's mapping, what would happen?"
   * Powers the confirm step on delete and deactivate.
   */
  @Post('preview-unlink')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee') || ability.can(Action.Manage, 'Student'))
  async previewUnlink(@Body() dto: PreviewUnlinkDto, @CurrentUser() user: IJwtStaffPayload) {
    this.assertSuperAdmin(user);
    const report = await this.resolution.resolve(
      { kind: 'device_pin', device_sn: dto.device_sn, device_pin: dto.device_pin },
      { actor: auditActorLabel(user), dryRun: true, overrideToUnmapped: true },
    );
    // On an unlink EVERY scan moves off the pin's current owner. They are the
    // subject of the operation, so without excluding them the dialog reports
    // that unlinking a student affects "1 other person" — every single time.
    const subject = await this.resolution.currentOwnerOf(dto.device_sn, dto.device_pin);
    return createApiResponse(
      await this.resolution.summariseImpact(report, subject),
      HttpStatus.OK,
      'Unlink preview generated',
    );
  }

  /** Read-only drift preview for a single device pin. */
  @Get('drift')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Employee'))
  async drift(
    @Query('device_sn') deviceSn: string,
    @Query('device_pin') devicePin: string,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    this.assertSuperAdmin(user);
    if (!deviceSn || !devicePin) {
      throw new BadRequestException('device_sn and device_pin are both required');
    }
    const report = await this.resolution.resolveForDevicePin(deviceSn, devicePin, {
      actor: auditActorLabel(user),
      dryRun: true,
    });
    return createApiResponse(report, HttpStatus.OK, 'Drift preview generated');
  }

  private buildScope(dto: ResolveScansDto): ResolutionScope {
    const from = dto.date_from ? this.parseDate(dto.date_from, 'date_from') : undefined;
    const to = dto.date_to ? this.parseDate(dto.date_to, 'date_to') : undefined;
    if (from && to && from > to) {
      throw new BadRequestException('date_from must be on or before date_to');
    }

    switch (dto.kind) {
      case 'scan_ids':
        if (!dto.scan_ids?.length) throw new BadRequestException('scan_ids is required for kind=scan_ids');
        return { kind: 'scan_ids', scan_ids: dto.scan_ids };

      case 'device_pin':
        if (!dto.device_sn || !dto.device_pin) {
          throw new BadRequestException('device_sn and device_pin are required for kind=device_pin');
        }
        return { kind: 'device_pin', device_sn: dto.device_sn, device_pin: dto.device_pin, date_from: from, date_to: to };

      case 'device':
        if (!dto.device_sn) throw new BadRequestException('device_sn is required for kind=device');
        return { kind: 'device', device_sn: dto.device_sn, date_from: from, date_to: to };

      case 'date_range':
        if (!from || !to) throw new BadRequestException('date_from and date_to are required for kind=date_range');
        return { kind: 'date_range', date_from: from, date_to: to, device_sn: dto.device_sn };
    }
  }

  private parseDate(value: string, field: string): Date {
    const d = new Date(value);
    if (isNaN(d.getTime())) throw new BadRequestException(`Invalid ${field}`);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }

  private assertSuperAdmin(user: IJwtStaffPayload) {
    if (user.role !== StaffRole.SUPER_ADMIN) {
      throw new ForbiddenException('Only super admins can re-resolve scan attribution');
    }
  }
}
