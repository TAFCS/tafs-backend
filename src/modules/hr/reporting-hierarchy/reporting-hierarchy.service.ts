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
import {
  type HierarchyPerson,
  isSeniorLeadership,
  managersOutsideFit,
  managersThatLoop,
} from './reporting-hierarchy.rules';

const PERSON_SELECT = {
  id: true,
  full_name: true,
  employee_code: true,
  job_title: true,
  campus_id: true,
  department_id: true,
  staff_category_id: true,
  photo_url: true,
  staff_categories: { select: { code: true } },
} as const;

const NOT_MIGRATED =
  'Reporting Hierarchy is not set up on the database yet. Run `prisma migrate deploy`, then try again.';

/**
 * Who reports to whom (TAFSD-327). SUPER_ADMIN only, by a raw role check: the
 * hierarchy is what permissions will later follow, so nobody inside it may
 * edit it. The tile is `superAdminOnly` too, so it can't be granted away.
 *
 * Lines are only stored here. Nothing in attendance, leave or pay reads them
 * yet; enforcement is a separate step once the tree has been filled in.
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

  /** Every active employee, plus every line between two active employees. */
  async getTree(user: IJwtStaffPayload) {
    this.assertSuperAdmin(user);
    const [people, campuses, departments] = await Promise.all([
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
          select: { employee_id: true, manager_id: true, is_primary: true },
          orderBy: [{ employee_id: 'asc' }, { is_primary: 'desc' }, { id: 'asc' }],
        }),
      [] as { employee_id: number; manager_id: number; is_primary: boolean }[],
      () => {
        migrated = false;
      },
    );

    return {
      migrated,
      employees: people.map(({ staff_categories, ...p }) => ({
        ...p,
        senior_leadership: isSeniorLeadership({ category_code: staff_categories?.code ?? null }),
      })),
      lines,
      campuses,
      departments,
    };
  }

  /** Replaces the set of people `employeeId` reports to. */
  async setManagers(employeeId: number, dto: SetManagersDto, user: IJwtStaffPayload) {
    this.assertSuperAdmin(user);
    const managerIds = [...new Set(dto.manager_ids)];
    if (managerIds.includes(employeeId)) {
      throw new BadRequestException('Someone cannot report to themselves.');
    }
    const primaryId = dto.primary_manager_id ?? managerIds[0] ?? null;
    if (primaryId != null && !managerIds.includes(primaryId)) {
      throw new BadRequestException('The primary manager must be one of the managers.');
    }

    const employee = await this.prisma.employee_profiles.findUnique({
      where: { id: employeeId },
      select: { ...PERSON_SELECT, employment_status: true },
    });
    if (!employee) throw new NotFoundException(`Employee #${employeeId} not found`);
    if (employee.employment_status !== EmployeeStatus.ACTIVE) {
      throw new BadRequestException(`${employee.full_name ?? 'This employee'} is no longer active.`);
    }

    const managers = managerIds.length
      ? await this.prisma.employee_profiles.findMany({
          where: { id: { in: managerIds } },
          select: { ...PERSON_SELECT, employment_status: true },
        })
      : [];
    const missing = managerIds.filter((id) => !managers.some((m) => m.id === id));
    if (missing.length) throw new NotFoundException(`Employee #${missing.join(', #')} not found`);
    const inactive = managers.filter((m) => m.employment_status !== EmployeeStatus.ACTIVE);
    if (inactive.length) {
      throw new BadRequestException(`${names(inactive)} ${inactive.length === 1 ? 'is' : 'are'} no longer active.`);
    }

    const outside = managersOutsideFit(toPerson(employee), managers.map(toPerson));
    if (outside.length) {
      throw new BadRequestException(
        `${names(outside)} ${outside.length === 1 ? 'is' : 'are'} not in the same department and campus as ` +
          `${employee.full_name ?? 'this employee'}. Only Senior Leadership can manage across departments or campuses.`,
      );
    }

    const currentLines = await this.readLines();
    const loops = managersThatLoop(currentLines, employeeId, managerIds);
    if (loops.length) {
      const looping = managers.filter((m) => loops.includes(m.id));
      throw new BadRequestException(
        `${names(looping)} already ${looping.length === 1 ? 'reports' : 'report'} to ` +
          `${employee.full_name ?? 'this employee'}, directly or further down, so can't also be above them.`,
      );
    }

    const before = currentLines.filter((l) => l.employee_id === employeeId).map((l) => l.manager_id);
    const changedBy = user.username ?? user.sub ?? null;

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.employee_reporting_lines.deleteMany({ where: { employee_id: employeeId } });
        if (managerIds.length) {
          await tx.employee_reporting_lines.createMany({
            data: managerIds.map((manager_id) => ({
              employee_id: employeeId,
              manager_id,
              is_primary: manager_id === primaryId,
              created_by: user.sub ?? null,
            })),
          });
        }
        const updated = await tx.employee_profiles.update({
          where: { id: employeeId },
          data: { reporting_manager_id: primaryId },
          include: { employee_class_section_assignments: true },
        });
        await this.progression.recordProgressionChange(tx, {
          employeeId,
          ...progressionSnapshotFromRow(updated),
          changeType: 'REASSIGNED',
          changedBy,
          notes: 'Reporting lines changed in Reporting Hierarchy',
        });
      });
    } catch (err) {
      if (isPendingMigrationError(err)) throw new ServiceUnavailableException(NOT_MIGRATED);
      throw err;
    }

    const nameById = new Map(managers.map((m) => [m.id, m.full_name ?? `#${m.id}`]));
    const beforeNames = before.length
      ? (
          await this.prisma.employee_profiles.findMany({
            where: { id: { in: before } },
            select: { id: true, full_name: true },
          })
        ).map((m) => m.full_name ?? `#${m.id}`)
      : [];
    this.auditLogs.log({
      entity_type: 'EMPLOYEE',
      entity_id: String(employeeId),
      action: 'UPDATED',
      section: 'hr',
      field: 'reporting_lines',
      old_value: beforeNames.join(', ') || null,
      new_value: managerIds.map((id) => nameById.get(id)).join(', ') || null,
      changed_by: user.sub ?? changedBy ?? 'system',
      note: `Reporting lines for ${employee.full_name ?? `employee #${employeeId}`} set in Reporting Hierarchy`,
    });

    return {
      employee_id: employeeId,
      lines: managerIds.map((manager_id) => ({ employee_id: employeeId, manager_id, is_primary: manager_id === primaryId })),
    };
  }

  private async readLines() {
    try {
      return await this.prisma.employee_reporting_lines.findMany({
        select: { employee_id: true, manager_id: true },
      });
    } catch (err) {
      if (isPendingMigrationError(err)) throw new ServiceUnavailableException(NOT_MIGRATED);
      throw err;
    }
  }
}

function toPerson(p: {
  id: number;
  full_name: string | null;
  campus_id: number | null;
  department_id: number | null;
  staff_categories: { code: string } | null;
}): HierarchyPerson {
  return {
    id: p.id,
    full_name: p.full_name,
    campus_id: p.campus_id,
    department_id: p.department_id,
    category_code: p.staff_categories?.code ?? null,
  };
}

function names(people: { id: number; full_name: string | null }[]): string {
  return people.map((p) => p.full_name ?? `#${p.id}`).join(', ');
}
