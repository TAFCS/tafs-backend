import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EmployeeStatus, StaffRole } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { isPendingMigrationError, readUntilMigrated } from '../../../utils/pending-migration.util';
import { EmployeeProgressionService, progressionSnapshotFromRow } from '../employees/employee-progression.service';
import { SetManagersDto } from './dto/set-managers.dto';

const PERSON_SELECT = {
  id: true,
  full_name: true,
  employee_code: true,
  job_title: true,
  campus_id: true,
  department_id: true,
  staff_category_id: true,
  photo_url: true,
} as const;

const NOT_MIGRATED =
  'Reporting Hierarchy is not set up on the database yet. Run `prisma migrate deploy`, then try again.';

/**
 * Who reports to whom (TAFSD-327). SUPER_ADMIN only, by a raw role check; the
 * tile is `superAdminOnly` too, so it can't be granted away.
 *
 * Super admins decide the lines entirely: any number of managers, at any
 * level, across departments and campuses. Only data validity is checked here
 * (the people exist and are still active).
 *
 * Lines are only stored. Nothing in attendance, leave or pay reads them yet;
 * that is TAFSD-328.
 */
@Injectable()
export class ReportingHierarchyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly progression: EmployeeProgressionService,
  ) {}

  private assertSuperAdmin(user: IJwtStaffPayload) {
    if (user?.role !== StaffRole.SUPER_ADMIN) {
      throw new ForbiddenException('Only a super admin can view or change the reporting hierarchy.');
    }
  }

  /** Every active employee, plus every line between two active employees, oldest first. */
  async getTree(user: IJwtStaffPayload) {
    this.assertSuperAdmin(user);
    const [employees, campuses, departments] = await Promise.all([
      this.prisma.employee_profiles.findMany({
        where: { employment_status: EmployeeStatus.ACTIVE },
        select: PERSON_SELECT,
        orderBy: { full_name: 'asc' },
      }),
      this.prisma.campuses.findMany({
        select: { id: true, campus_name: true, campus_code: true },
        orderBy: { id: 'asc' },
      }),
      this.prisma.departments.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    ]);

    let migrated = true;
    const lines = await readUntilMigrated(
      () =>
        this.prisma.employee_reporting_lines.findMany({
          where: {
            employee: { employment_status: EmployeeStatus.ACTIVE },
            manager: { employment_status: EmployeeStatus.ACTIVE },
          },
          select: { employee_id: true, manager_id: true },
          orderBy: { id: 'asc' },
        }),
      [] as { employee_id: number; manager_id: number }[],
      () => {
        migrated = false;
      },
    );

    return { migrated, employees, lines, campuses, departments };
  }

  /** Replaces the set of people `employeeId` reports to. */
  async setManagers(employeeId: number, dto: SetManagersDto, user: IJwtStaffPayload) {
    this.assertSuperAdmin(user);
    const managerIds = [...new Set(dto.manager_ids)];

    const employee = await this.prisma.employee_profiles.findUnique({
      where: { id: employeeId },
      select: { id: true, full_name: true, employment_status: true },
    });
    if (!employee) throw new NotFoundException(`Employee #${employeeId} not found`);
    if (employee.employment_status !== EmployeeStatus.ACTIVE) {
      throw new BadRequestException(`${employee.full_name ?? 'This employee'} is no longer active.`);
    }

    const managers = managerIds.length
      ? await this.prisma.employee_profiles.findMany({
          where: { id: { in: managerIds } },
          select: { id: true, full_name: true, employment_status: true },
        })
      : [];
    const missing = managerIds.filter((id) => !managers.some((m) => m.id === id));
    if (missing.length) throw new NotFoundException(`Employee #${missing.join(', #')} not found`);
    const inactive = managers.filter((m) => m.employment_status !== EmployeeStatus.ACTIVE);
    if (inactive.length) {
      throw new BadRequestException(
        `${inactive.map((m) => m.full_name ?? `#${m.id}`).join(', ')} ${inactive.length === 1 ? 'is' : 'are'} no longer active.`,
      );
    }

    const changedBy = user.username ?? user.sub ?? null;
    let before: number[] = [];
    try {
      before = await this.prisma.$transaction(async (tx) => {
        const old = await tx.employee_reporting_lines.findMany({
          where: { employee_id: employeeId },
          select: { manager_id: true },
          orderBy: { id: 'asc' },
        });
        await tx.employee_reporting_lines.deleteMany({ where: { employee_id: employeeId } });
        // One insert per line, in order, so ids keep the order given.
        for (const manager_id of managerIds) {
          await tx.employee_reporting_lines.create({
            data: { employee_id: employeeId, manager_id, created_by: user.sub ?? null },
          });
        }
        const updated = await tx.employee_profiles.update({
          where: { id: employeeId },
          data: { reporting_manager_id: managerIds[0] ?? null },
          include: { employee_class_section_assignments: true },
        });
        await this.progression.recordProgressionChange(tx, {
          employeeId,
          ...progressionSnapshotFromRow(updated),
          changeType: 'REASSIGNED',
          changedBy,
          notes: 'Reporting lines changed in Reporting Hierarchy',
        });
        return old.map((l) => l.manager_id);
      });
    } catch (err) {
      if (isPendingMigrationError(err)) throw new ServiceUnavailableException(NOT_MIGRATED);
      throw err;
    }

    const allIds = [...new Set([...before, ...managerIds])];
    const nameById = new Map(
      (allIds.length
        ? await this.prisma.employee_profiles.findMany({
            where: { id: { in: allIds } },
            select: { id: true, full_name: true },
          })
        : []
      ).map((m) => [m.id, m.full_name ?? `#${m.id}`]),
    );
    this.auditLogs.log({
      entity_type: 'EMPLOYEE',
      entity_id: String(employeeId),
      action: 'UPDATED',
      section: 'hr',
      field: 'reporting_lines',
      old_value: before.map((id) => nameById.get(id)).join(', ') || null,
      new_value: managerIds.map((id) => nameById.get(id)).join(', ') || null,
      changed_by: user.sub ?? changedBy ?? 'system',
      note: `Reporting lines for ${employee.full_name ?? `employee #${employeeId}`} set in Reporting Hierarchy`,
    });

    return {
      employee_id: employeeId,
      lines: managerIds.map((manager_id) => ({ employee_id: employeeId, manager_id })),
    };
  }
}
