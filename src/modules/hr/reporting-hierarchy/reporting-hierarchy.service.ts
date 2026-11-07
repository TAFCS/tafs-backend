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
import { ScopeService } from '../../../common/scope/scope.service';
import { HierarchyService } from '../../../common/hierarchy/hierarchy.service';
import type {
  DeskMemberMismatch,
  HierarchyReportMismatch,
  ScopeMismatchReport,
} from '../../../common/hierarchy/hierarchy.types';
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
  private readonly hierarchy: HierarchyService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly progression: EmployeeProgressionService,
    private readonly scope: ScopeService,
    hierarchy?: HierarchyService,
  ) {
    this.hierarchy = hierarchy ?? new HierarchyService(this.prisma);
  }

  private assertSuperAdmin(user: IJwtStaffPayload) {
    if (user?.role !== StaffRole.SUPER_ADMIN) {
      throw new ForbiddenException('Only a super admin can view or change the reporting hierarchy.');
    }
  }

  /** Every active employee, plus every line between two active employees, oldest first. */
  async getTree(user: IJwtStaffPayload) {
    this.assertSuperAdmin(user);
    const [employees, campuses, departments, enforced] = await Promise.all([
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
      this.scope.isHierarchyEnforced(),
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

    return { migrated, employees, lines, campuses, departments, enforced };
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

    this.scope.invalidateScopeCache();
    this.hierarchy.invalidateCache();

    return {
      employee_id: employeeId,
      lines: managerIds.map((manager_id) => ({ employee_id: employeeId, manager_id })),
    };
  }

  /** Sets whether reporting hierarchy is actively enforced on actions. SUPER_ADMIN only. */
  async setEnforcement(enforced: boolean, user: IJwtStaffPayload) {
    this.assertSuperAdmin(user);
    await this.scope.setHierarchyEnforced(enforced, user.sub ?? user.username ?? 'super_admin');
    this.auditLogs.log({
      entity_type: 'APP_CONFIG',
      entity_id: 'enforce_reporting_hierarchy',
      action: 'UPDATED',
      section: 'hr',
      field: 'enforce_reporting_hierarchy',
      old_value: null,
      new_value: String(enforced),
      changed_by: user.sub ?? user.username ?? 'super_admin',
      note: `Reporting hierarchy enforcement turned ${enforced ? 'ON' : 'OFF'} by ${user.fullName ?? user.username ?? 'super admin'}`,
    });
    return { enforced };
  }

  /**
   * Generates a read-only mismatch report:
   * 1. Manager -> report pairs where the report's campus, segment or department is outside manager's scope.
   * 2. Desk members whose manager chain reaches no one covering that desk's campus.
   */
  async getMismatches(user: IJwtStaffPayload): Promise<ScopeMismatchReport> {
    this.assertSuperAdmin(user);

    const [lines, employees, campuses, segments, departments, queues, rules] = await Promise.all([
      readUntilMigrated(
        () =>
          this.prisma.employee_reporting_lines.findMany({
            where: {
              employee: { employment_status: EmployeeStatus.ACTIVE },
              manager: { employment_status: EmployeeStatus.ACTIVE },
            },
            select: { employee_id: true, manager_id: true },
          }),
        [] as { employee_id: number; manager_id: number }[],
      ),
      this.prisma.employee_profiles.findMany({
        where: { employment_status: EmployeeStatus.ACTIVE },
        select: {
          id: true,
          full_name: true,
          user_id: true,
          campus_id: true,
          segment_id: true,
          department_id: true,
        },
      }),
      this.prisma.campuses.findMany({ select: { id: true, campus_name: true } }),
      this.prisma.segments.findMany({ select: { id: true, name: true } }),
      this.prisma.departments.findMany({ select: { id: true, name: true } }),
      this.prisma.ticket_queues.findMany({
        where: { is_active: true },
        include: {
          members: {
            include: {
              user: { select: { id: true, full_name: true, is_active: true, deleted_at: true, role: true } },
            },
          },
        },
      }),
      this.prisma.ticket_routing_rules.findMany({
        where: { is_active: true, campus_id: { not: null } },
        select: { target_queue_id: true, campus_id: true },
      }),
    ]);

    const campusMap = new Map(campuses.map((c) => [c.id, c.campus_name]));
    const segmentMap = new Map(segments.map((s) => [s.id, s.name]));
    const departmentMap = new Map(departments.map((d) => [d.id, d.name]));
    const empById = new Map(employees.map((e) => [e.id, e]));
    const empByUserId = new Map(employees.filter((e) => e.user_id).map((e) => [e.user_id!, e]));

    // Resolve user roles & scopes for managers
    const userRoleCache = new Map<string, string>();
    const userScopeCache = new Map<string, any>();

    const getManagerInfo = async (userId: string) => {
      if (!userRoleCache.has(userId)) {
        const u = await this.prisma.users.findUnique({
          where: { id: userId },
          select: { id: true, role: true },
        });
        userRoleCache.set(userId, u?.role ?? 'STAFF');
      }
      const role = userRoleCache.get(userId);
      if (role === 'SUPER_ADMIN' || role === 'DEVELOPER') {
        return { isExempt: true, scope: null, role };
      }
      if (!userScopeCache.has(userId)) {
        const s = await this.scope.resolveEffective(userId);
        userScopeCache.set(userId, s);
      }
      return { isExempt: false, scope: userScopeCache.get(userId), role };
    };

    // 1. Manager -> report pairs mismatch
    const managerReportMismatches: HierarchyReportMismatch[] = [];
    for (const line of lines) {
      const manager = empById.get(line.manager_id);
      const report = empById.get(line.employee_id);
      if (!manager || !report) continue;

      if (!manager.user_id) {
        managerReportMismatches.push({
          managerId: manager.id,
          managerName: manager.full_name ?? `Employee #${manager.id}`,
          managerRole: null,
          reportId: report.id,
          reportName: report.full_name ?? `Employee #${report.id}`,
          reportCampus: report.campus_id
            ? { id: report.campus_id, name: campusMap.get(report.campus_id) ?? `#${report.campus_id}` }
            : null,
          reportSegment: report.segment_id
            ? { id: report.segment_id, name: segmentMap.get(report.segment_id) ?? `#${report.segment_id}` }
            : null,
          reportDepartment: report.department_id
            ? { id: report.department_id, name: departmentMap.get(report.department_id) ?? `#${report.department_id}` }
            : null,
          mismatchedDimensions: ['campus'],
          reason: `${manager.full_name ?? `Employee #${manager.id}`} has no system login account so they have no system scope over ${report.full_name ?? `Employee #${report.id}`}.`,
        });
        continue;
      }

      const mgrInfo = await getManagerInfo(manager.user_id);
      if (mgrInfo.isExempt) continue;

      const mismatchedDimensions: ('campus' | 'segment' | 'department')[] = [];
      const reasons: string[] = [];

      if (
        mgrInfo.scope.campuses.length > 0 &&
        report.campus_id != null &&
        !mgrInfo.scope.campuses.includes(report.campus_id)
      ) {
        mismatchedDimensions.push('campus');
        reasons.push(`campus "${campusMap.get(report.campus_id) ?? report.campus_id}"`);
      }

      if (
        mgrInfo.scope.segments.length > 0 &&
        report.segment_id != null &&
        !mgrInfo.scope.segments.includes(report.segment_id)
      ) {
        mismatchedDimensions.push('segment');
        reasons.push(`segment "${segmentMap.get(report.segment_id) ?? report.segment_id}"`);
      }

      if (
        mgrInfo.scope.departments.length > 0 &&
        report.department_id != null &&
        !mgrInfo.scope.departments.includes(report.department_id)
      ) {
        mismatchedDimensions.push('department');
        reasons.push(`department "${departmentMap.get(report.department_id) ?? report.department_id}"`);
      }

      if (mismatchedDimensions.length > 0) {
        managerReportMismatches.push({
          managerId: manager.id,
          managerName: manager.full_name ?? `Employee #${manager.id}`,
          managerRole: mgrInfo.role,
          reportId: report.id,
          reportName: report.full_name ?? `Employee #${report.id}`,
          reportCampus: report.campus_id
            ? { id: report.campus_id, name: campusMap.get(report.campus_id) ?? `#${report.campus_id}` }
            : null,
          reportSegment: report.segment_id
            ? { id: report.segment_id, name: segmentMap.get(report.segment_id) ?? `#${report.segment_id}` }
            : null,
          reportDepartment: report.department_id
            ? { id: report.department_id, name: departmentMap.get(report.department_id) ?? `#${report.department_id}` }
            : null,
          mismatchedDimensions,
          reason: `${report.full_name ?? `Employee #${report.id}`} is in ${reasons.join(' and ')}, which is outside ${manager.full_name ?? `Employee #${manager.id}`}'s assigned scope.`,
        });
      }
    }

    // 2. Desk members whose manager chain reaches no one covering that desk's campus
    const deskMemberMismatches: DeskMemberMismatch[] = [];
    const queueCampuses = new Map<number, Set<number>>();
    for (const rule of rules) {
      if (rule.target_queue_id != null && rule.campus_id != null) {
        const set = queueCampuses.get(rule.target_queue_id) ?? new Set<number>();
        set.add(rule.campus_id);
        queueCampuses.set(rule.target_queue_id, set);
      }
    }

    for (const queue of queues) {
      const campusesForQueue = queueCampuses.get(queue.id);
      if (!campusesForQueue || campusesForQueue.size === 0) continue;

      const activeMembers = queue.members.filter((m) => m.user?.is_active && !m.user?.deleted_at);
      for (const member of activeMembers) {
        const emp = empByUserId.get(member.user_id);
        const managerEmpIds = emp ? await this.hierarchy.above(member.user_id) : [];
        const chainEmpIds = emp ? [emp.id, ...managerEmpIds] : [];

        for (const campusId of campusesForQueue) {
          let campusCovered = false;

          // Check if member themselves or anyone in their manager chain covers campusId
          for (const chainEmpId of chainEmpIds) {
            const chainEmp = empById.get(chainEmpId);
            if (!chainEmp?.user_id) continue;

            const info = await getManagerInfo(chainEmp.user_id);
            if (info.isExempt || info.scope.campuses.length === 0 || info.scope.campuses.includes(campusId)) {
              campusCovered = true;
              break;
            }
          }

          if (!campusCovered) {
            const campusName = campusMap.get(campusId) ?? `#${campusId}`;
            deskMemberMismatches.push({
              queueId: queue.id,
              queueName: queue.name,
              deskCampus: { id: campusId, name: campusName },
              memberUserId: member.user_id,
              memberEmployeeId: emp?.id ?? null,
              memberName: member.user.full_name,
              reason: `Desk "${queue.name}" receives tickets for ${campusName}, but neither ${member.user.full_name} nor any manager in their reporting chain has scope covering ${campusName}.`,
            });
          }
        }
      }
    }

    return {
      managerReportMismatches,
      deskMemberMismatches,
      totalMismatches: managerReportMismatches.length + deskMemberMismatches.length,
    };
  }
}
