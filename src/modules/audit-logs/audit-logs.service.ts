import { Injectable } from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTOR_UUID_RE,
  AUDIT_SYSTEM_ACTOR_LABELS,
  resolveAuditActorDisplay,
} from '../../common/utils/audit-actor.util';
import { QueryAuditLogsDto } from './dto/query-audit-logs.dto';

const SECTION_ENTITY_TYPES: Record<string, string[]> = {
  student: ['STUDENT', 'GUARDIAN', 'FAMILY', 'TRANSFER', 'STUDENT_FLAG'],
  finance: [
    'VOUCHER',
    'DEPOSIT',
    'CLASS_FEE_SCHEDULE',
    'STUDENT_FEE_SCHEDULE',
    'BULK_VOUCHER',
    'CHEQUE',
    'DISCOUNT_PRESET',
    'SCHOLARSHIP_PRESET',
    'STUDENT_FEE_INSTALLMENT',
    'BUNDLE_NAME',
  ],
  communication: ['NOTICE', 'EMPLOYEE_NOTICE', 'SUPPORT_TICKET', 'CHAT_CONVERSATION', 'CHAT_MESSAGE'],
  hr: [
    'EMPLOYEE',
    'DEPARTMENT',
    'STAFF_CATEGORY',
    'LEAVE_REQUEST',
    'PAYROLL_RUN',
    'HR_POLICY_SET',
    'HR_POLICY_RULE',
    'ACADEMIC_CALENDAR_DAY',
    'SATURDAY_SCHEDULE',
    'EMPLOYEE_SHIFT_OVERRIDE',
  ],
  attendance: [
    'STUDENT_ATTENDANCE',
    'STAFF_ATTENDANCE',
    'ATTENDANCE_OBJECTION',
    'CLASS_ATTENDANCE_MODE',
    'TIMETABLE',
    'TIMETABLE_SLOT',
    'SUBJECT',
    'ZK_ATTENDANCE_MAPPING',
    'CLASS_CHECK_IN_SCHEDULE',
    'ROLL_SESSION',
  ],
  'school-setup': ['CAMPUS', 'CLASS', 'SECTION', 'FEE_TYPE', 'BANK'],
  'house-balancer': ['HOUSE'],
  system: ['USER', 'PERMISSION', 'BACKUP'],
  'app-config': ['APP_CONFIG'],
  'parent-requests': ['PARENT_CHANGE_REQUEST'],
};

const HOUSE_BALANCER_STUDENT_NOTES = [
  'Reassigned via house balancer',
  'Reassigned via campus-wide house balancer',
] as const;

const SUPER_ADMIN_ONLY_ENTITY_TYPES = ['PARENT_CHANGE_REQUEST'];

/** entity_id on these rows is employee_profiles.id */
const EMPLOYEE_ENTITY_TYPES = new Set(['STAFF_ATTENDANCE', 'EMPLOYEE']);

export type AuditLogParams = {
  entity_type: string;
  entity_id: string;
  action: string;
  section?: string | null;
  field?: string | null;
  old_value?: string | null;
  new_value?: string | null;
  changed_by: string;
  student_id?: number | null;
  note?: string | null;
  parent_id?: number | null;
};

@Injectable()
export class AuditLogsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Log an event. Fire-and-forget safe: failures are swallowed so user actions
   * are never blocked. Returns the new row id when successful (for grouping).
   */
  async log(params: AuditLogParams): Promise<number | null> {
    try {
      const section = params.section ?? this.deriveSectionFromEntityType(params.entity_type);
      const row = await this.prisma.audit_logs.create({
        data: {
          entity_type: params.entity_type,
          entity_id: params.entity_id,
          action: params.action,
          section,
          field: params.field || null,
          old_value: params.old_value || null,
          new_value: params.new_value || null,
          changed_by: params.changed_by,
          student_id: params.student_id || null,
          note: params.note || null,
          parent_id: params.parent_id ?? null,
        },
        select: { id: true },
      });
      return row.id;
    } catch (err) {
      console.error('[AuditLog] Failed to write log entry:', err);
      return null;
    }
  }

  /**
   * One user action → one parent row + optional child detail rows.
   * Children inherit changed_by from the parent when omitted.
   */
  async logGroup(
    parent: AuditLogParams,
    children: Array<Omit<AuditLogParams, 'changed_by'> & { changed_by?: string }> = [],
  ): Promise<number | null> {
    const parentId = await this.log(parent);
    if (parentId == null || children.length === 0) return parentId;

    for (const child of children) {
      await this.log({
        ...child,
        changed_by: child.changed_by ?? parent.changed_by,
        parent_id: parentId,
      });
    }
    return parentId;
  }

  private deriveSectionFromEntityType(entityType: string): string | null {
    for (const [section, types] of Object.entries(SECTION_ENTITY_TYPES)) {
      if (types.includes(entityType)) return section;
    }
    return null;
  }

  /**
   * Find logs matching query criteria.
   * Global feed: top-level parents only (`parent_id` null), with `children` attached.
   * Student-scoped: top-level rows for that student (parent_id null, or orphans whose
   * parent is not student-scoped), each with nested children when available.
   */
  async findAll(query: QueryAuditLogsDto, requestingUser?: { role?: string }) {
    const where: any = {};
    const studentId = query.student_id ? Number(query.student_id) : null;
    const isStudentScoped = studentId != null && Number.isFinite(studentId);

    // Global activity feed hides children (they're nested under parents).
    // Student timelines also return top-level rows only; children are nested below.
    if (!isStudentScoped) {
      where.parent_id = null;
    }

    if (isStudentScoped) {
      where.student_id = studentId;
    }
    if (query.section === 'house-balancer') {
      where.AND = [
        ...(where.AND ?? []),
        {
          OR: [
            { section: 'house-balancer' },
            {
              entity_type: 'HOUSE',
              action: { in: ['REBALANCED', 'CAMPUS_REBALANCED'] },
            },
          ],
        },
      ];
    } else if (query.section) {
      const sectionTypes = SECTION_ENTITY_TYPES[query.section] ?? [];
      if (sectionTypes.length > 0 && !where.entity_type) {
        where.OR = [
          { section: query.section },
          { entity_type: { in: sectionTypes } },
        ];
      } else {
        where.section = query.section;
      }
    }
    if (query.entity_type) {
      const types = query.entity_type.split(',').map((t) => t.trim()).filter(Boolean);
      if (types.length > 1) {
        where.entity_type = { in: types };
      } else if (types.length === 1) {
        where.entity_type = types[0];
      }
    }
    if (query.entity_id) {
      where.entity_id = query.entity_id;
    }
    if (query.changed_by) {
      where.changed_by = { contains: query.changed_by, mode: 'insensitive' };
    }

    if (query.from || query.to) {
      where.changed_at = {};
      if (query.from) {
        where.changed_at.gte = new Date(query.from);
      }
      if (query.to) {
        where.changed_at.lte = new Date(query.to);
      }
    }

    const clauses: any[] = [where];

    if (!isStudentScoped) {
      clauses.push({
        NOT: {
          AND: [
            { field: 'student.house_id' },
            { note: { in: [...HOUSE_BALANCER_STUDENT_NOTES] } },
          ],
        },
      });
    }

    const isSuperAdmin = requestingUser?.role === StaffRole.SUPER_ADMIN;
    if (!isSuperAdmin) {
      clauses.push({ entity_type: { notIn: SUPER_ADMIN_ONLY_ENTITY_TYPES } });
    }

    const finalWhere = clauses.length === 1 ? clauses[0] : { AND: clauses };

    const limit = Number(query.limit) || 50;
    const offset = Number(query.offset) || 0;

    // Student-scoped: load matching rows, then collapse children under parents before page.
    if (isStudentScoped) {
      const allMatching = await this.prisma.audit_logs.findMany({
        where: finalWhere,
        orderBy: { changed_at: 'desc' },
      });

      const byId = new Map(allMatching.map((r) => [r.id, r]));
      const childIds = new Set(
        allMatching.filter((r) => r.parent_id != null && byId.has(r.parent_id)).map((r) => r.id),
      );
      // Top-level for student: no parent, or parent not in this student result set (orphan child of bulk).
      const topLevel = allMatching.filter((r) => !childIds.has(r.id));
      const total = topLevel.length;
      const page = topLevel.slice(offset, offset + limit);

      // Hydrate children of page parents (from full student match + any siblings by parent_id).
      const parentIds = page.map((p) => p.id);
      const nestedFromMatch = allMatching.filter(
        (r) => r.parent_id != null && parentIds.includes(r.parent_id),
      );
      const extraChildren =
        parentIds.length === 0
          ? []
          : await this.prisma.audit_logs.findMany({
              where: {
                parent_id: { in: parentIds },
                id: { notIn: nestedFromMatch.map((c) => c.id) },
              },
              orderBy: { id: 'asc' },
            });
      const children = [...nestedFromMatch, ...extraChildren];
      const childrenByParent = new Map<number, typeof children>();
      for (const child of children) {
        if (child.parent_id == null) continue;
        const list = childrenByParent.get(child.parent_id) ?? [];
        list.push(child);
        childrenByParent.set(child.parent_id, list);
      }

      return this.enrichAndReturn(page, childrenByParent, total);
    }

    const [data, total] = await Promise.all([
      this.prisma.audit_logs.findMany({
        where: finalWhere,
        orderBy: { changed_at: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.audit_logs.count({ where: finalWhere }),
    ]);

    const parentIds = data.map((d) => d.id);
    const children =
      parentIds.length === 0
        ? []
        : await this.prisma.audit_logs.findMany({
            where: { parent_id: { in: parentIds } },
            orderBy: { id: 'asc' },
          });

    const childrenByParent = new Map<number, typeof children>();
    for (const child of children) {
      if (child.parent_id == null) continue;
      const list = childrenByParent.get(child.parent_id) ?? [];
      list.push(child);
      childrenByParent.set(child.parent_id, list);
    }

    return this.enrichAndReturn(data, childrenByParent, total);
  }

  private collectActors(
    data: Array<{ id: number; changed_by: string }>,
    childrenByParent: Map<number, Array<{ changed_by: string }>>,
  ): string[] {
    const actors = new Set<string>();
    for (const log of data) {
      actors.add(log.changed_by);
      for (const child of childrenByParent.get(log.id) ?? []) {
        actors.add(child.changed_by);
      }
    }
    return [...actors];
  }

  private async buildActorDisplayMap(actors: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();

    for (const actor of actors) {
      const systemLabel = AUDIT_SYSTEM_ACTOR_LABELS[actor];
      if (systemLabel) map.set(actor, systemLabel);
    }

    const unresolved = actors.filter((actor) => !map.has(actor));
    const uuids = unresolved.filter((actor) => AUDIT_ACTOR_UUID_RE.test(actor));
    const usernames = unresolved.filter((actor) => !AUDIT_ACTOR_UUID_RE.test(actor));

    const orClauses: Array<{ id: { in: string[] } } | { username: { in: string[] } }> = [];
    if (uuids.length > 0) orClauses.push({ id: { in: uuids } });
    if (usernames.length > 0) orClauses.push({ username: { in: usernames } });

    const userById = new Map<string, { full_name: string; username: string }>();
    const userByUsername = new Map<string, { full_name: string; username: string }>();

    if (orClauses.length > 0) {
      const users = await this.prisma.users.findMany({
        where: { OR: orClauses },
        select: { id: true, username: true, full_name: true },
      });

      for (const user of users) {
        userById.set(user.id, user);
        userByUsername.set(user.username, user);
      }
    }

    for (const actor of actors) {
      if (!map.has(actor)) {
        map.set(actor, resolveAuditActorDisplay(actor, userById, userByUsername));
      }
    }

    return map;
  }

  private collectEmployeeIds(
    data: Array<{ id: number; entity_type: string; entity_id: string }>,
    childrenByParent: Map<number, Array<{ entity_type: string; entity_id: string }>>,
  ): number[] {
    const ids = new Set<number>();

    const maybeAdd = (log: { entity_type: string; entity_id: string }) => {
      if (!EMPLOYEE_ENTITY_TYPES.has(log.entity_type)) return;
      const id = Number.parseInt(log.entity_id, 10);
      if (Number.isFinite(id)) ids.add(id);
    };

    for (const log of data) {
      maybeAdd(log);
      for (const child of childrenByParent.get(log.id) ?? []) {
        maybeAdd(child);
      }
    }

    return [...ids];
  }

  private async buildEmployeeDisplayMap(
    employeeIds: number[],
  ): Promise<Map<number, { full_name: string | null; employee_code: string | null }>> {
    const map = new Map<number, { full_name: string | null; employee_code: string | null }>();
    if (employeeIds.length === 0) return map;

    const employees = await this.prisma.employee_profiles.findMany({
      where: { id: { in: employeeIds } },
      select: { id: true, full_name: true, employee_code: true },
    });

    for (const employee of employees) {
      map.set(employee.id, {
        full_name: employee.full_name,
        employee_code: employee.employee_code,
      });
    }

    return map;
  }

  private async enrichAndReturn(
    data: Array<{
      id: number;
      entity_type: string;
      entity_id: string;
      action: string;
      field: string | null;
      old_value: string | null;
      new_value: string | null;
      changed_by: string;
      changed_at: Date;
      note: string | null;
      student_id: number | null;
      section: string | null;
      parent_id: number | null;
    }>,
    childrenByParent: Map<number, typeof data>,
    total: number,
  ) {
    const actorDisplayMap = await this.buildActorDisplayMap(this.collectActors(data, childrenByParent));
    const employeeIds = this.collectEmployeeIds(data, childrenByParent);
    const employeeDisplayMap = await this.buildEmployeeDisplayMap(employeeIds);

    const [allClasses, allCampuses, allSections, allHouses] = await Promise.all([
      this.prisma.classes.findMany({
        select: { id: true, description: true },
      }),
      this.prisma.campuses.findMany({
        select: { id: true, campus_name: true },
      }),
      this.prisma.sections.findMany({
        select: { id: true, description: true },
      }),
      this.prisma.houses.findMany({
        select: { id: true, house_name: true, house_color: true },
      }),
    ]);

    const classMap = new Map(allClasses.map((c) => [c.id.toString(), c.description]));
    const campusMap = new Map(allCampuses.map((c) => [c.id.toString(), c.campus_name]));
    const sectionMap = new Map(allSections.map((s) => [s.id.toString(), s.description]));
    const houseMap = new Map(
      allHouses.map((h) => [h.id.toString(), h.house_name || `House #${h.id}`]),
    );

    const enrichHouseCounts = (raw: string): string => {
      try {
        const counts = JSON.parse(raw) as Record<string, number>;
        return Object.entries(counts)
          .map(([id, count]) => `${houseMap.get(id) ?? `House #${id}`}: ${count}`)
          .join(', ');
      } catch {
        return raw;
      }
    };

    const enrichHouseBalancerNote = (note: string | null): string | null => {
      if (!note) return note;

      const sectionMatch = note.match(
        /^Rebalanced (\d+) students for campus=(\d+) class=(\d+) section=(\d+)\. before=(\{.*\}) after=(\{.*\})$/,
      );
      if (sectionMatch) {
        const [, count, campusId, classId, sectionId, beforeRaw, afterRaw] = sectionMatch;
        const campusName = campusMap.get(campusId) ?? `Campus #${campusId}`;
        const className = classMap.get(classId) ?? `Class #${classId}`;
        const sectionName = sectionMap.get(sectionId) ?? `Section #${sectionId}`;
        return `Rebalanced ${count} students · ${campusName} · ${className} · Section ${sectionName}. Before: ${enrichHouseCounts(beforeRaw)}. After: ${enrichHouseCounts(afterRaw)}`;
      }

      const campusMatch = note.match(
        /^Rebalanced (\d+) students across (\d+) class\/section groups at campus=(\d+)(?: class=(\d+))?$/,
      );
      if (campusMatch) {
        const [, count, groups, campusId, classId] = campusMatch;
        const campusName = campusMap.get(campusId) ?? `Campus #${campusId}`;
        const classPart = classId
          ? ` · ${classMap.get(classId) ?? `Class #${classId}`}`
          : ' (all classes)';
        return `Rebalanced ${count} students across ${groups} class/section groups · ${campusName}${classPart}`;
      }

      return note;
    };

    const enrichLog = (log: (typeof data)[number]) => {
      let oldVal = log.old_value;
      let newVal = log.new_value;
      let note = log.note;

      if (log.field === 'class_id' || log.field === 'student.class_id') {
        if (oldVal && classMap.has(oldVal)) {
          oldVal = classMap.get(oldVal) ?? null;
        }
        if (newVal && classMap.has(newVal)) {
          newVal = classMap.get(newVal) ?? null;
        }
      } else if (log.field === 'campus_id' || log.field === 'student.campus_id') {
        if (oldVal && campusMap.has(oldVal)) {
          oldVal = campusMap.get(oldVal) ?? null;
        }
        if (newVal && campusMap.has(newVal)) {
          newVal = campusMap.get(newVal) ?? null;
        }
      }

      if (
        log.entity_type === 'HOUSE' &&
        (log.action === 'REBALANCED' || log.action === 'CAMPUS_REBALANCED')
      ) {
        note = enrichHouseBalancerNote(note);
      }

      let employee_id: number | null = null;
      let employee_name: string | null = null;
      let employee_code: string | null = null;

      if (EMPLOYEE_ENTITY_TYPES.has(log.entity_type)) {
        const parsedId = Number.parseInt(log.entity_id, 10);
        if (Number.isFinite(parsedId)) {
          employee_id = parsedId;
          const employee = employeeDisplayMap.get(parsedId);
          if (employee) {
            employee_name = employee.full_name?.trim() || null;
            employee_code = employee.employee_code?.trim() || null;
          }
        }
      }

      return {
        ...log,
        old_value: oldVal,
        new_value: newVal,
        note,
        changed_by_display: actorDisplayMap.get(log.changed_by) ?? log.changed_by,
        employee_id,
        employee_name,
        employee_code,
      };
    };

    const enrichedData = data.map((log) => {
      const enriched = enrichLog(log);
      const kids = (childrenByParent.get(log.id) ?? []).map(enrichLog);
      return {
        ...enriched,
        children: kids,
        child_count: kids.length,
      };
    });

    return { data: enrichedData, total };
  }
}
