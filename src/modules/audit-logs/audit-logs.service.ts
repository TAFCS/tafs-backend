import { Injectable } from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { QueryAuditLogsDto } from './dto/query-audit-logs.dto';

const SECTION_ENTITY_TYPES: Record<string, string[]> = {
  student: ['STUDENT', 'GUARDIAN', 'FAMILY', 'TRANSFER', 'STUDENT_FLAG'],
  finance: ['VOUCHER', 'DEPOSIT', 'CLASS_FEE_SCHEDULE', 'STUDENT_FEE_SCHEDULE', 'BULK_VOUCHER', 'CHEQUE', 'DISCOUNT_PRESET', 'STUDENT_FEE_INSTALLMENT', 'BUNDLE_NAME'],
  communication: ['NOTICE', 'EMPLOYEE_NOTICE', 'SUPPORT_TICKET', 'CHAT_CONVERSATION', 'CHAT_MESSAGE'],
  hr: ['EMPLOYEE', 'DEPARTMENT', 'LEAVE_REQUEST', 'PAYROLL_RUN', 'HR_POLICY_SET', 'HR_POLICY_RULE', 'ACADEMIC_CALENDAR_DAY', 'SATURDAY_SCHEDULE'],
  attendance: ['STUDENT_ATTENDANCE', 'STAFF_ATTENDANCE', 'ATTENDANCE_OBJECTION', 'CLASS_ATTENDANCE_MODE', 'TIMETABLE', 'TIMETABLE_SLOT', 'SUBJECT', 'ZK_ATTENDANCE_MAPPING', 'CLASS_CHECK_IN_SCHEDULE'],
  'school-setup': ['CAMPUS', 'CLASS', 'SECTION', 'FEE_TYPE', 'BANK'],
  'house-balancer': ['HOUSE'],
  system: ['USER', 'PERMISSION', 'BACKUP', 'APP_CONFIG'],
  'app-config': ['APP_CONFIG'],
  'parent-requests': ['PARENT_CHANGE_REQUEST'],
};

// Per-student house-balancer rows clutter global Activity Logs; the HOUSE summary row is enough there.
const HOUSE_BALANCER_STUDENT_NOTES = [
  'Reassigned via house balancer',
  'Reassigned via campus-wide house balancer',
] as const;

// Entity types whose audit trail is restricted to super admins only, regardless
// of which sections/roles are otherwise allowed to view /audit-logs.
const SUPER_ADMIN_ONLY_ENTITY_TYPES = ['PARENT_CHANGE_REQUEST'];

@Injectable()
export class AuditLogsService {
  constructor(private readonly prisma: PrismaService) { }

  /**
   * Log an event. This is fire-and-forget and safe.
   * If it fails, we catch the error to ensure user actions aren't blocked.
   */
  async log(params: {
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
  }) {
    try {
      // Auto-derive section from entity_type if not explicitly provided
      const section = params.section ?? this.deriveSectionFromEntityType(params.entity_type);
      await this.prisma.audit_logs.create({
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
        },
      });
    } catch (err) {
      console.error('[AuditLog] Failed to write log entry:', err);
    }
  }

  private deriveSectionFromEntityType(entityType: string): string | null {
    for (const [section, types] of Object.entries(SECTION_ENTITY_TYPES)) {
      if (types.includes(entityType)) return section;
    }
    return null;
  }

  /**
   * Find logs matching query criteria.
   * `requestingUser` is used to strip out entity types that are restricted
   * to super admins (e.g. parent data-change requests) for anyone else.
   */
  async findAll(query: QueryAuditLogsDto, requestingUser?: { role?: string }) {
    const where: any = {};

    if (query.student_id) {
      where.student_id = Number(query.student_id);
    }
    if (query.section === 'house-balancer') {
      // Dedicated House Rebalancer tab: bundled HOUSE runs (new + legacy school-setup rows)
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
      // Filter by section: translate to the entity_types that belong to that section
      const sectionTypes = SECTION_ENTITY_TYPES[query.section] ?? [];
      where.section = query.section;
      if (sectionTypes.length > 0 && !where.entity_type) {
        // Also support older rows that may not have section set yet
        where.OR = [
          { section: query.section },
          { section: null, entity_type: { in: sectionTypes } },
        ];
        delete where.section;
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

    // Global activity feed: hide per-student house-balancer spam; keep HOUSE summary rows.
    // Student modal (student_id set) still receives the per-student moves.
    if (!query.student_id) {
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

    const [data, total] = await Promise.all([
      this.prisma.audit_logs.findMany({
        where: finalWhere,
        orderBy: { changed_at: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.audit_logs.count({ where: finalWhere }),
    ]);

    // Fetch classes, campuses, sections, and houses to map IDs to names
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

      // Section rebalance: campus=1 class=21 section=1. before={...} after={...}
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

      // Campus rebalance: ... at campus=1 class=2
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

    const enrichedData = data.map((log) => {
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

      return {
        ...log,
        old_value: oldVal,
        new_value: newVal,
        note,
      };
    });

    return { data: enrichedData, total };
  }
}
