import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TicketStatus } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { ORIGINATION_OPTIONS } from '../../../common/support-ticket-routing';
import { TicketRoutingService } from './ticket-routing.service';
import {
  CreateRoutingRuleDto,
  CreateTicketQueueDto,
  RoutingPreviewDto,
  UpdateRoutingRuleDto,
  UpdateTicketQueueDto,
} from './dto/routing-admin.dto';

const userBrief = { select: { id: true, full_name: true, username: true, role: true, is_active: true } };

const queueView = {
  members: {
    orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
    select: { sort_order: true, user: userBrief },
  },
  _count: { select: { tickets: { where: { status: { in: [TicketStatus.OPEN, TicketStatus.ASSIGNED] } } } } },
} satisfies Prisma.ticket_queuesInclude;

const ruleView = {
  target_user: userBrief,
  target_queue: { select: { id: true, name: true, is_active: true } },
} satisfies Prisma.ticket_routing_rulesInclude;

const AUDIT_ENTITY = 'SUPPORT_TICKET_ROUTING';

/** Dashboard management of routing rules and queues. Super admins only. */
@Injectable()
export class TicketRoutingAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly routing: TicketRoutingService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  private assertAdmin(staff: IJwtStaffPayload) {
    if (staff.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Only super admins can manage ticket routing');
    }
  }

  // ─── Read ──────────────────────────────────────────────────────────────────

  async overview(staff: IJwtStaffPayload) {
    this.assertAdmin(staff);
    const [rules, queues, campuses, segments, classes, users] = await Promise.all([
      this.prisma.ticket_routing_rules.findMany({ include: ruleView, orderBy: [{ category: 'asc' }, { id: 'asc' }] }),
      this.prisma.ticket_queues.findMany({ include: queueView, orderBy: { name: 'asc' } }),
      this.prisma.campuses.findMany({ select: { id: true, campus_name: true }, orderBy: { id: 'asc' } }),
      this.prisma.segments.findMany({ select: { id: true, name: true }, orderBy: { display_order: 'asc' } }),
      this.prisma.classes.findMany({ select: { id: true, description: true, segment_id: true }, orderBy: { id: 'asc' } }),
      this.prisma.users.findMany({
        where: { is_active: true, deleted_at: null, username: { not: '_seed_actor' } },
        select: { id: true, full_name: true, username: true, role: true },
        orderBy: { full_name: 'asc' },
      }),
    ]);
    const subtopics = [
      ...new Set([
        ...ORIGINATION_OPTIONS.topics.GENERAL_WITH_CHILD,
        ...ORIGINATION_OPTIONS.topics.GENERAL_NO_CHILD,
        ...ORIGINATION_OPTIONS.topics.FINANCIAL,
      ]),
    ];
    return {
      rules,
      queues: queues.map(({ _count, ...q }) => ({ ...q, open_tickets: _count.tickets })),
      options: { campuses, segments, classes, staff: users, subtopics: ORIGINATION_OPTIONS.topics, all_subtopics: subtopics },
    };
  }

  async health(staff: IJwtStaffPayload) {
    this.assertAdmin(staff);
    return this.routing.health();
  }

  async preview(staff: IJwtStaffPayload, dto: RoutingPreviewDto) {
    this.assertAdmin(staff);
    let student: { campus_id: number | null; class_id: number | null; segment_id: number | null } | null = null;
    let label: string | null = null;
    if (dto.student_cc != null) {
      const row = await this.prisma.students.findFirst({
        where: { cc: dto.student_cc, deleted_at: null },
        select: {
          full_name: true,
          campus_id: true,
          class_id: true,
          classes: { select: { description: true, segment_id: true } },
          campuses: { select: { campus_name: true } },
        },
      });
      if (!row) throw new NotFoundException(`No student with CC ${dto.student_cc}`);
      student = { campus_id: row.campus_id, class_id: row.class_id, segment_id: row.classes?.segment_id ?? null };
      label = [row.full_name, row.campuses?.campus_name, row.classes?.description].filter(Boolean).join(' · ');
    }
    const decision = await this.routing.resolve({ category: dto.category, subtopic: dto.subtopic, student });
    return { student: label, ...decision };
  }

  async userImpact(staff: IJwtStaffPayload, userId: string) {
    this.assertAdmin(staff);
    return this.routing.userImpact(userId);
  }

  // ─── Rules ─────────────────────────────────────────────────────────────────

  async createRule(staff: IJwtStaffPayload, dto: CreateRoutingRuleDto) {
    this.assertAdmin(staff);
    await this.validateRule(dto);
    const rule = await this.prisma.ticket_routing_rules.create({
      data: { ...this.ruleData(dto), updated_by: staff.username },
      include: ruleView,
    });
    this.audit(staff, `rule:${rule.id}`, 'CREATED', `Routing rule "${rule.name}" created`, null, rule);
    return rule;
  }

  async updateRule(staff: IJwtStaffPayload, id: number, dto: UpdateRoutingRuleDto) {
    this.assertAdmin(staff);
    const before = await this.prisma.ticket_routing_rules.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Rule not found');
    await this.validateRule({ ...before, ...dto } as CreateRoutingRuleDto);
    const rule = await this.prisma.ticket_routing_rules.update({
      where: { id },
      data: { ...this.ruleData(dto), updated_by: staff.username },
      include: ruleView,
    });
    this.audit(staff, `rule:${id}`, 'UPDATED', `Routing rule "${rule.name}" updated`, before, rule);
    return rule;
  }

  async deleteRule(staff: IJwtStaffPayload, id: number) {
    this.assertAdmin(staff);
    const before = await this.prisma.ticket_routing_rules.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Rule not found');
    await this.prisma.ticket_routing_rules.delete({ where: { id } });
    this.audit(staff, `rule:${id}`, 'DELETED', `Routing rule "${before.name}" deleted`, before, null);
    return { id };
  }

  private ruleData(dto: Partial<CreateRoutingRuleDto>) {
    const data: Prisma.ticket_routing_rulesUncheckedUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.category !== undefined) data.category = dto.category;
    if (dto.child_match !== undefined) data.child_match = dto.child_match;
    if (dto.campus_id !== undefined) data.campus_id = dto.campus_id;
    if (dto.segment_id !== undefined) data.segment_id = dto.segment_id;
    if (dto.class_ids !== undefined) data.class_ids = [...new Set(dto.class_ids)];
    if (dto.subtopic !== undefined) data.subtopic = dto.subtopic?.trim() || null;
    if (dto.target_user_id !== undefined) data.target_user_id = dto.target_user_id;
    if (dto.target_queue_id !== undefined) data.target_queue_id = dto.target_queue_id;
    if (dto.priority !== undefined) data.priority = dto.priority;
    if (dto.is_active !== undefined) data.is_active = dto.is_active;
    return data as Prisma.ticket_routing_rulesUncheckedCreateInput;
  }

  private async validateRule(dto: CreateRoutingRuleDto) {
    const hasUser = !!dto.target_user_id;
    const hasQueue = dto.target_queue_id != null;
    if (hasUser === hasQueue) {
      throw new BadRequestException('A rule needs exactly one target: a staff member or a queue');
    }
    if (hasUser) {
      const user = await this.prisma.users.findFirst({
        where: { id: dto.target_user_id!, deleted_at: null },
        select: { id: true },
      });
      if (!user) throw new BadRequestException('Target staff member not found');
    }
    if (hasQueue) {
      const queue = await this.prisma.ticket_queues.findUnique({
        where: { id: dto.target_queue_id! },
        select: { category: true },
      });
      if (!queue) throw new BadRequestException('Target queue not found');
      if (queue.category !== dto.category) {
        throw new BadRequestException('A rule can only target a queue of the same category');
      }
    }
    const placed = dto.campus_id != null || dto.segment_id != null || (dto.class_ids?.length ?? 0) > 0;
    if (placed && dto.child_match === 'NO_CHILD') {
      throw new BadRequestException('Campus, segment and class conditions need a ticket about a child');
    }
  }

  // ─── Queues ────────────────────────────────────────────────────────────────

  async createQueue(staff: IJwtStaffPayload, dto: CreateTicketQueueDto) {
    this.assertAdmin(staff);
    const queue = await this.saveQueue(staff, null, dto);
    this.audit(staff, `queue:${queue.id}`, 'CREATED', `Ticket queue "${queue.name}" created`, null, queue);
    return queue;
  }

  async updateQueue(staff: IJwtStaffPayload, id: number, dto: UpdateTicketQueueDto) {
    this.assertAdmin(staff);
    const before = await this.prisma.ticket_queues.findUnique({ where: { id }, include: queueView });
    if (!before) throw new NotFoundException('Queue not found');
    if (dto.category && dto.category !== before.category) {
      const rules = await this.prisma.ticket_routing_rules.count({ where: { target_queue_id: id } });
      if (rules > 0) throw new ConflictException('Queue category cannot change while rules point at it');
    }
    const queue = await this.saveQueue(staff, id, dto);
    this.audit(staff, `queue:${id}`, 'UPDATED', `Ticket queue "${queue.name}" updated`, before, queue);
    return queue;
  }

  async deleteQueue(staff: IJwtStaffPayload, id: number) {
    this.assertAdmin(staff);
    const before = await this.prisma.ticket_queues.findUnique({ where: { id }, include: queueView });
    if (!before) throw new NotFoundException('Queue not found');
    if (before.is_fallback) {
      throw new ConflictException('Make another queue the fallback before deleting this one');
    }
    if (before._count.tickets > 0) {
      throw new ConflictException(`Queue has ${before._count.tickets} open tickets; switch it off instead`);
    }
    await this.prisma.ticket_queues.delete({ where: { id } });
    this.audit(staff, `queue:${id}`, 'DELETED', `Ticket queue "${before.name}" deleted`, before, null);
    return { id };
  }

  private async saveQueue(staff: IJwtStaffPayload, id: number | null, dto: UpdateTicketQueueDto) {
    if (dto.member_ids) {
      const ids = [...new Set(dto.member_ids)];
      const found = await this.prisma.users.count({ where: { id: { in: ids }, deleted_at: null } });
      if (found !== ids.length) throw new BadRequestException('One or more members were not found');
    }
    try {
      const saved = await this.prisma.$transaction(async (tx) => {
        const data = {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.category !== undefined ? { category: dto.category } : {}),
          ...(dto.assignment !== undefined ? { assignment: dto.assignment } : {}),
          ...(dto.allow_forward !== undefined ? { allow_forward: dto.allow_forward } : {}),
          ...(dto.is_fallback !== undefined ? { is_fallback: dto.is_fallback } : {}),
          ...(dto.is_active !== undefined ? { is_active: dto.is_active } : {}),
          updated_by: staff.username,
        };
        if (dto.is_fallback) {
          // One fallback per category (unique index): release it elsewhere first.
          const category =
            dto.category ?? (id ? (await tx.ticket_queues.findUniqueOrThrow({ where: { id } })).category : undefined);
          await tx.ticket_queues.updateMany({
            where: { category, is_fallback: true, ...(id ? { id: { not: id } } : {}) },
            data: { is_fallback: false, updated_by: staff.username },
          });
        }
        const queue = id
          ? await tx.ticket_queues.update({ where: { id }, data })
          : await tx.ticket_queues.create({
              data: { ...data, name: dto.name!.trim(), category: dto.category! },
            });
        if (dto.member_ids) {
          await tx.ticket_queue_members.deleteMany({ where: { queue_id: queue.id } });
          await tx.ticket_queue_members.createMany({
            data: [...new Set(dto.member_ids)].map((user_id, sort_order) => ({ queue_id: queue.id, user_id, sort_order })),
          });
        }
        return tx.ticket_queues.findUniqueOrThrow({ where: { id: queue.id }, include: queueView });
      });
      const { _count, ...rest } = saved;
      return { ...rest, open_tickets: _count.tickets };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const target = String((e.meta as { target?: unknown } | undefined)?.target ?? '');
        throw new ConflictException(
          target.includes('name') ? 'A queue with that name already exists' : 'Another queue already holds that role',
        );
      }
      throw e;
    }
  }

  private audit(
    staff: IJwtStaffPayload,
    entityId: string,
    action: string,
    note: string,
    before: unknown,
    after: unknown,
  ) {
    void this.auditLogs.log({
      entity_type: AUDIT_ENTITY,
      entity_id: entityId,
      action,
      changed_by: staff.username,
      old_value: before ? JSON.stringify(before).slice(0, 4000) : null,
      new_value: after ? JSON.stringify(after).slice(0, 4000) : null,
      note,
    });
  }
}
