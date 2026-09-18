import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { CreateSegmentDto } from './dto/create-segment.dto';
import { UpdateSegmentDto } from './dto/update-segment.dto';
import { SetCampusSegmentsDto } from './dto/set-campus-segments.dto';

@Injectable()
export class SegmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  /**
   * Segment ids each campus runs, keyed by campus id.
   *
   * A campus with no rows at all is treated as unrestricted rather than as
   * running nothing: a campus created before anyone configures its segments
   * would otherwise have an unusable, silently empty Segment picker. Once a
   * campus has any row, that row set is the whole truth for it.
   */
  async getCampusSegmentMap(): Promise<Map<number, Set<number>>> {
    const rows = await this.prisma.campus_segments.findMany({
      where: { is_active: true },
      select: { campus_id: true, segment_id: true },
    });
    const map = new Map<number, Set<number>>();
    for (const row of rows) {
      if (!map.has(row.campus_id)) map.set(row.campus_id, new Set());
      map.get(row.campus_id)!.add(row.segment_id);
    }
    return map;
  }

  /** The mapping in the shape the clients consume it. */
  async listCampusSegments() {
    const [campuses, map] = await Promise.all([
      this.prisma.campuses.findMany({
        where: { is_active: true },
        select: { id: true, campus_code: true, campus_name: true },
        orderBy: { id: 'asc' },
      }),
      this.getCampusSegmentMap(),
    ]);
    return campuses.map((c) => ({
      campus_id: c.id,
      campus_code: c.campus_code,
      campus_name: c.campus_name,
      // null, not [], when nothing is configured — "unrestricted" and "runs no
      // segment" are different answers and the client has to tell them apart.
      segment_ids: map.has(c.id) ? Array.from(map.get(c.id)!).sort((a, b) => a - b) : null,
    }));
  }

  /** True when `segmentId` may be assigned to someone posted at `campusId`. */
  async isSegmentAllowedAtCampus(campusId: number | null, segmentId: number | null) {
    if (!segmentId || !campusId) return true;
    const map = await this.getCampusSegmentMap();
    const allowed = map.get(campusId);
    return !allowed || allowed.has(segmentId);
  }

  async assertSegmentAllowedAtCampus(campusId: number | null, segmentId: number | null) {
    if (await this.isSegmentAllowedAtCampus(campusId, segmentId)) return;
    const [campus, segment] = await Promise.all([
      this.prisma.campuses.findUnique({
        where: { id: campusId! },
        select: { campus_name: true },
      }),
      this.prisma.segments.findUnique({
        where: { id: segmentId! },
        select: { name: true },
      }),
    ]);
    throw new BadRequestException(
      `${campus?.campus_name ?? `Campus ${campusId}`} does not run the ` +
        `${segment?.name ?? `segment ${segmentId}`} segment.`,
    );
  }

  async setCampusSegments(campusId: number, dto: SetCampusSegmentsDto, user?: any) {
    const campus = await this.prisma.campuses.findUnique({
      where: { id: campusId },
      select: { id: true, campus_name: true },
    });
    if (!campus) {
      throw new NotFoundException(`Campus with ID ${campusId} not found.`);
    }

    const segmentIds = Array.from(new Set(dto.segment_ids));
    const found = await this.prisma.segments.findMany({
      where: { id: { in: segmentIds } },
      select: { id: true, name: true },
      orderBy: { display_order: 'asc' },
    });
    if (found.length !== segmentIds.length) {
      const missing = segmentIds.filter((id) => !found.some((s) => s.id === id));
      throw new BadRequestException(`Unknown segment ids: ${missing.join(', ')}`);
    }

    const before = await this.prisma.campus_segments.findMany({
      where: { campus_id: campusId },
      select: { segment_id: true, segments: { select: { name: true } } },
    });

    await this.prisma.$transaction([
      this.prisma.campus_segments.deleteMany({
        where: { campus_id: campusId, segment_id: { notIn: segmentIds } },
      }),
      ...segmentIds.map((segment_id) =>
        this.prisma.campus_segments.upsert({
          where: { campus_id_segment_id: { campus_id: campusId, segment_id } },
          create: { campus_id: campusId, segment_id },
          update: { is_active: true },
        }),
      ),
    ]);

    const actorName = user?.fullName || user?.username || 'system';
    this.auditLogs.log({
      entity_type: 'CAMPUS_SEGMENTS',
      entity_id: String(campusId),
      action: 'UPDATED',
      section: 'hr',
      old_value: before.map((r) => r.segments.name).sort().join(', ') || '(none)',
      new_value: found.map((s) => s.name).join(', ') || '(none)',
      note: `Segments run by ${campus.campus_name}`,
      changed_by: actorName,
    });

    return this.listCampusSegments();
  }

  async findAll(campusId?: number) {
    const campusSegmentMap = await this.getCampusSegmentMap();
    const allowedAtCampus = campusId ? campusSegmentMap.get(campusId) : undefined;

    const segments = await this.prisma.segments.findMany({
      orderBy: [{ display_order: 'asc' }, { name: 'asc' }],
      include: {
        classes: {
          include: {
            campus_classes: {
              where: { is_active: true },
              include: { campuses: { select: { id: true, campus_name: true } } },
            },
          },
          orderBy: { id: 'asc' },
        },
      },
    });

    // Fetch active employees matching campus filter if provided
    const employeeWhere: any = {
      employment_status: 'ACTIVE',
    };
    if (campusId) {
      employeeWhere.campus_id = campusId;
    }

    const [directEmployees, teacherAssignments] = await Promise.all([
      this.prisma.employee_profiles.findMany({
        where: {
          ...employeeWhere,
          segment_id: { not: null },
        },
        select: {
          id: true,
          employee_code: true,
          full_name: true,
          job_title: true,
          photo_url: true,
          campus_id: true,
          segment_id: true,
          campuses: { select: { id: true, campus_name: true } },
        },
      }),
      this.prisma.employee_class_section_assignments.findMany({
        where: {
          employee_profiles: employeeWhere,
          classes: { segment_id: { not: null } },
        },
        select: {
          employee_id: true,
          class_id: true,
          classes: {
            select: {
              id: true,
              description: true,
              class_code: true,
              segment_id: true,
            },
          },
          sections: {
            select: {
              id: true,
              description: true,
            },
          },
          employee_profiles: {
            select: {
              id: true,
              employee_code: true,
              full_name: true,
              job_title: true,
              photo_url: true,
              campus_id: true,
              segment_id: true,
              campuses: { select: { id: true, campus_name: true } },
            },
          },
        },
      }),
    ]);

    // Build segments response with filtered classes and allocated staff.
    // When a campus is asked for and it has a configured segment set, segments
    // it does not run drop out entirely — not just their classes.
    const visibleSegments = allowedAtCampus
      ? segments.filter((seg) => allowedAtCampus.has(seg.id))
      : segments;

    return visibleSegments.map((seg) => {
      // Filter classes if campusId is provided
      const filteredClasses = campusId
        ? seg.classes.filter((c) =>
            c.campus_classes.some((cc) => cc.campus_id === campusId && cc.is_active !== false),
          )
        : seg.classes;

      // Collect staff for this segment
      const staffMap = new Map<number, {
        id: number;
        employee_code: string | null;
        full_name: string | null;
        job_title: string | null;
        photo_url: string | null;
        campus_id: number | null;
        campus_name: string | null;
        is_direct_segment_member: boolean;
        assigned_classes: string[];
      }>();

      // 1. Direct segment members
      directEmployees
        .filter((emp) => emp.segment_id === seg.id)
        .forEach((emp) => {
          staffMap.set(emp.id, {
            id: emp.id,
            employee_code: emp.employee_code,
            full_name: emp.full_name,
            job_title: emp.job_title,
            photo_url: emp.photo_url,
            campus_id: emp.campus_id,
            campus_name: emp.campuses?.campus_name || null,
            is_direct_segment_member: true,
            assigned_classes: [],
          });
        });

      // 2. Teachers assigned to classes in this segment
      teacherAssignments
        .filter((ta) => ta.classes.segment_id === seg.id)
        .forEach((ta) => {
          const emp = ta.employee_profiles;
          if (!staffMap.has(emp.id)) {
            staffMap.set(emp.id, {
              id: emp.id,
              employee_code: emp.employee_code,
              full_name: emp.full_name,
              job_title: emp.job_title,
              photo_url: emp.photo_url,
              campus_id: emp.campus_id,
              campus_name: emp.campuses?.campus_name || null,
              is_direct_segment_member: emp.segment_id === seg.id,
              assigned_classes: [],
            });
          }
          const staffObj = staffMap.get(emp.id)!;
          const classLabel = `${ta.classes.description}${ta.sections?.description ? ` (${ta.sections.description})` : ''}`;
          if (!staffObj.assigned_classes.includes(classLabel)) {
            staffObj.assigned_classes.push(classLabel);
          }
        });

      const staffList = Array.from(staffMap.values()).sort((a, b) =>
        (a.full_name || '').localeCompare(b.full_name || ''),
      );

      return {
        id: seg.id,
        code: seg.code,
        name: seg.name,
        display_order: seg.display_order,
        // Which campuses run this segment, so a client that loaded the full
        // list once can narrow it as the user switches campus without a refetch.
        campus_ids: Array.from(campusSegmentMap.entries())
          .filter(([, segIds]) => segIds.has(seg.id))
          .map(([cid]) => cid)
          .sort((a, b) => a - b),
        classes: filteredClasses.map((c) => ({
          id: c.id,
          description: c.description,
          class_code: c.class_code,
          academic_system: c.academic_system,
          campuses: c.campus_classes.map((cc) => ({
            id: cc.campuses.id,
            campus_name: cc.campuses.campus_name,
          })),
        })),
        staff: staffList,
        _count: {
          classes: filteredClasses.length,
          employee_profiles: staffList.length,
        },
      };
    });
  }

  async listAvailableClasses() {
    return this.prisma.classes.findMany({
      orderBy: { id: 'asc' },
      select: {
        id: true,
        description: true,
        class_code: true,
        academic_system: true,
        segment_id: true,
        campus_classes: {
          where: { is_active: true },
          select: {
            campus_id: true,
            campuses: {
              select: {
                id: true,
                campus_name: true,
              },
            },
          },
        },
      },
    });
  }

  async create(dto: CreateSegmentDto, user?: any) {
    const code = dto.code.trim().toUpperCase();
    const existing = await this.prisma.segments.findUnique({
      where: { code },
    });
    if (existing) {
      throw new ConflictException(`A segment with code "${code}" already exists.`);
    }

    const segment = await this.prisma.segments.create({
      data: {
        code,
        name: dto.name.trim(),
        display_order: dto.display_order ?? 0,
      },
    });

    if (dto.class_ids && dto.class_ids.length > 0) {
      await this.prisma.classes.updateMany({
        where: { id: { in: dto.class_ids } },
        data: { segment_id: segment.id },
      });
    }

    // Log Audit
    const actorName = user?.fullName || user?.username || 'system';
    this.auditLogs.log({
      entity_type: 'SEGMENT',
      entity_id: String(segment.id),
      action: 'CREATED',
      section: 'hr',
      new_value: `${segment.name} (${segment.code})`,
      note: dto.class_ids && dto.class_ids.length > 0 ? `Assigned ${dto.class_ids.length} classes` : undefined,
      changed_by: actorName,
    });

    return segment;
  }

  async update(id: number, dto: UpdateSegmentDto, user?: any) {
    const existing = await this.prisma.segments.findUnique({
      where: { id },
      include: { classes: { select: { id: true } } },
    });
    if (!existing) {
      throw new NotFoundException(`Segment with ID ${id} not found.`);
    }

    if (dto.code && dto.code.trim().toUpperCase() !== existing.code) {
      const code = dto.code.trim().toUpperCase();
      const duplicate = await this.prisma.segments.findUnique({
        where: { code },
      });
      if (duplicate && duplicate.id !== id) {
        throw new ConflictException(`A segment with code "${code}" already exists.`);
      }
    }

    const updated = await this.prisma.segments.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name.trim() }),
        ...(dto.code !== undefined && { code: dto.code.trim().toUpperCase() }),
        ...(dto.display_order !== undefined && { display_order: dto.display_order }),
      },
    });

    if (dto.class_ids !== undefined) {
      // Remove classes no longer assigned
      await this.prisma.classes.updateMany({
        where: {
          segment_id: id,
          id: { notIn: dto.class_ids },
        },
        data: { segment_id: null },
      });

      // Assign newly assigned classes
      if (dto.class_ids.length > 0) {
        await this.prisma.classes.updateMany({
          where: { id: { in: dto.class_ids } },
          data: { segment_id: id },
        });
      }
    }

    // Log Audit
    const actorName = user?.fullName || user?.username || 'system';
    this.auditLogs.log({
      entity_type: 'SEGMENT',
      entity_id: String(id),
      action: 'UPDATED',
      section: 'hr',
      old_value: `${existing.name} (${existing.code})`,
      new_value: `${updated.name} (${updated.code})`,
      note: dto.class_ids !== undefined ? `Updated class assignments (${dto.class_ids.length} classes)` : undefined,
      changed_by: actorName,
    });

    return updated;
  }

  async remove(id: number, user?: any) {
    const existing = await this.prisma.segments.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException(`Segment with ID ${id} not found.`);
    }

    // Unassign classes
    await this.prisma.classes.updateMany({
      where: { segment_id: id },
      data: { segment_id: null },
    });

    // Unassign employee profiles
    await this.prisma.employee_profiles.updateMany({
      where: { segment_id: id },
      data: { segment_id: null },
    });

    // Unassign employee progression periods
    await this.prisma.employee_progression_periods.updateMany({
      where: { segment_id: id },
      data: { segment_id: null },
    });

    // Delete segment
    await this.prisma.segments.delete({
      where: { id },
    });

    // Log Audit
    const actorName = user?.fullName || user?.username || 'system';
    this.auditLogs.log({
      entity_type: 'SEGMENT',
      entity_id: String(id),
      action: 'DELETED',
      section: 'hr',
      old_value: `${existing.name} (${existing.code})`,
      changed_by: actorName,
    });

    return { success: true, message: `Segment "${existing.name}" deleted successfully` };
  }
}
