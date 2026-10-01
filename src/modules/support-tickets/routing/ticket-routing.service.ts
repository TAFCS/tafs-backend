import { Injectable } from '@nestjs/common';
import {
  Prisma,
  StaffRole,
  TicketCategory,
  TicketQueueAssignment,
  TicketStatus,
} from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { ScopeService } from '../../../common/scope/scope.service';
import type { UserScope } from '../../../common/scope/scope.types';

/** Scopes read during one routing pass, so a person is looked up once. */
type ScopeCache = Map<string, Promise<UserScope>>;
import {
  laneFor,
  orderMatchingRules,
  type RoutingSubject,
} from '../../../common/support-ticket-routing';

const staffSelect = {
  id: true,
  full_name: true,
  username: true,
  role: true,
  is_active: true,
  deleted_at: true,
} satisfies Prisma.usersSelect;

type StaffRow = Prisma.usersGetPayload<{ select: typeof staffSelect }>;

const queueInclude = {
  members: {
    orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
    include: { user: { select: staffSelect } },
  },
} satisfies Prisma.ticket_queuesInclude;

type QueueRow = Prisma.ticket_queuesGetPayload<{ include: typeof queueInclude }>;

const ruleInclude = {
  target_user: { select: staffSelect },
  target_queue: { include: queueInclude },
} satisfies Prisma.ticket_routing_rulesInclude;

type RuleRow = Prisma.ticket_routing_rulesGetPayload<{ include: typeof ruleInclude }>;

/** One step of the routing decision, kept so admins can see why a ticket landed where it did. */
export interface RoutingStep {
  rule_id: number | null;
  rule_name: string;
  outcome: 'routed' | 'skipped';
  reason: string;
}

export interface RoutingDecision {
  routedRole: StaffRole;
  assigneeId: string | null;
  status: TicketStatus;
  queueId: number | null;
  ruleId: number | null;
  /** Set when anything other than the first matching rule decided the route. */
  note: string | null;
  target: { kind: 'user' | 'queue' | 'none'; id: string | number | null; name: string | null };
  steps: RoutingStep[];
}

type TargetOutcome =
  | { ok: true; assigneeId: string | null; status: TicketStatus; queueId: number | null; kind: 'user' | 'queue'; name: string }
  | { ok: false; reason: string };

export interface RoutingIssue {
  severity: 'error' | 'warning';
  code:
    | 'RULE_TARGET_INACTIVE'
    | 'RULE_NO_TARGET'
    | 'RULE_TARGET_OUT_OF_SCOPE'
    | 'QUEUE_NO_ACTIVE_MEMBERS'
    | 'QUEUE_SINGLE_MEMBER'
    | 'NO_FALLBACK_QUEUE'
    | 'UNCOVERED_PLACEMENT';
  message: string;
  rule_id?: number;
  queue_id?: number;
  campus_id?: number;
  class_id?: number;
}

@Injectable()
export class TicketRoutingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
  ) {}

  // ─── Resolution ────────────────────────────────────────────────────────────

  /**
   * Decide where a new ticket goes. Never throws for want of a destination: every
   * miss is recorded in `steps` and the ticket falls through to the category's
   * fallback queue, or as a last resort sits unassigned for super admins.
   */
  async resolve(subject: RoutingSubject): Promise<RoutingDecision> {
    const scopes: ScopeCache = new Map();
    const rules = await this.prisma.ticket_routing_rules.findMany({
      where: { is_active: true, category: subject.category },
      include: ruleInclude,
    });

    const steps: RoutingStep[] = [];
    for (const rule of orderMatchingRules(rules, subject)) {
      const outcome = await this.evaluateRuleTarget(rule, subject, scopes);
      if (outcome.ok) {
        steps.push({ rule_id: rule.id, rule_name: rule.name, outcome: 'routed', reason: `to ${outcome.name}` });
        return this.decision(subject, outcome, rule.id, steps);
      }
      steps.push({ rule_id: rule.id, rule_name: rule.name, outcome: 'skipped', reason: outcome.reason });
    }

    const fallback = await this.prisma.ticket_queues.findFirst({
      where: { category: subject.category, is_fallback: true, is_active: true },
      include: queueInclude,
    });
    if (fallback) {
      const outcome = await this.evaluateQueue(fallback, subject, scopes);
      if (outcome.ok) {
        steps.push({ rule_id: null, rule_name: 'Fallback queue', outcome: 'routed', reason: `to ${outcome.name}` });
        return this.decision(subject, outcome, null, steps);
      }
      // Nobody in the fallback can take it — leave it in the queue unclaimed
      // rather than reject the parent; super admins see it in oversight.
      steps.push({
        rule_id: null,
        rule_name: 'Fallback queue',
        outcome: 'routed',
        reason: `to ${fallback.name}, unassigned (${outcome.reason})`,
      });
      return this.decision(
        subject,
        { ok: true, assigneeId: null, status: TicketStatus.OPEN, queueId: fallback.id, kind: 'queue', name: fallback.name },
        null,
        steps,
      );
    }

    steps.push({ rule_id: null, rule_name: 'No route', outcome: 'routed', reason: 'unassigned — no rule matched and no fallback queue is set' });
    return {
      routedRole: laneFor(subject.category, 'none'),
      assigneeId: null,
      status: TicketStatus.OPEN,
      queueId: null,
      ruleId: null,
      note: describeSteps(steps),
      target: { kind: 'none', id: null, name: null },
      steps,
    };
  }

  private decision(
    subject: RoutingSubject,
    outcome: Extract<TargetOutcome, { ok: true }>,
    ruleId: number | null,
    steps: RoutingStep[],
  ): RoutingDecision {
    const clean = steps.length === 1 && ruleId != null;
    return {
      routedRole: laneFor(subject.category, outcome.kind),
      assigneeId: outcome.assigneeId,
      status: outcome.status,
      queueId: outcome.queueId,
      ruleId,
      note: clean ? null : describeSteps(steps),
      target: {
        kind: outcome.kind,
        id: outcome.kind === 'queue' ? outcome.queueId : outcome.assigneeId,
        name: outcome.name,
      },
      steps,
    };
  }

  private async evaluateRuleTarget(
    rule: RuleRow,
    subject: RoutingSubject,
    scopes: ScopeCache,
  ): Promise<TargetOutcome> {
    if (rule.target_user) {
      const reason = await this.ineligibility(rule.target_user, subject, scopes);
      if (reason) return { ok: false, reason: `${rule.target_user.full_name} ${reason}` };
      return {
        ok: true,
        assigneeId: rule.target_user.id,
        status: TicketStatus.ASSIGNED,
        queueId: null,
        kind: 'user',
        name: rule.target_user.full_name,
      };
    }
    if (rule.target_queue) return this.evaluateQueue(rule.target_queue, subject, scopes);
    return { ok: false, reason: 'rule has no target' };
  }

  private async evaluateQueue(
    queue: QueueRow,
    subject: RoutingSubject,
    scopes: ScopeCache,
  ): Promise<TargetOutcome> {
    if (!queue.is_active) return { ok: false, reason: `queue ${queue.name} is switched off` };
    const eligible: StaffRow[] = [];
    for (const m of queue.members) {
      if (!(await this.ineligibility(m.user, subject, scopes))) {
        eligible.push(m.user);
        if (queue.assignment === TicketQueueAssignment.AUTO) break;
      }
    }
    if (eligible.length === 0) {
      return { ok: false, reason: `queue ${queue.name} has no active member who can see this student` };
    }
    if (queue.assignment === TicketQueueAssignment.AUTO) {
      return {
        ok: true,
        assigneeId: eligible[0].id,
        status: TicketStatus.ASSIGNED,
        queueId: queue.id,
        kind: 'queue',
        name: `${queue.name} (${eligible[0].full_name})`,
      };
    }
    return { ok: true, assigneeId: null, status: TicketStatus.OPEN, queueId: queue.id, kind: 'queue', name: queue.name };
  }

  /** Why this person cannot take the ticket, or null when they can. */
  private async ineligibility(
    user: StaffRow,
    subject: RoutingSubject,
    scopes: ScopeCache,
  ): Promise<string | null> {
    if (!user.is_active || user.deleted_at) return 'is inactive';
    const student = subject.student;
    if (!student) return null;
    const scope = await this.scopeOf(user.id, scopes);
    const visible = this.scope.canSeeStudent(
      { role: user.role, scope },
      { campus_id: student.campus_id, class_id: student.class_id, segment_id: student.segment_id },
    );
    return visible ? null : "cannot see this student (outside their access scope)";
  }

  private scopeOf(userId: string, scopes: ScopeCache): Promise<UserScope> {
    let scope = scopes.get(userId);
    if (!scope) {
      scope = this.scope.resolve(userId);
      scopes.set(userId, scope);
    }
    return scope;
  }

  // ─── Membership ────────────────────────────────────────────────────────────

  /** Active queues the staff member belongs to. */
  async queuesFor(userId: string) {
    return this.prisma.ticket_queues.findMany({
      where: { is_active: true, members: { some: { user_id: userId } } },
      select: { id: true, name: true, category: true, assignment: true, allow_forward: true },
      orderBy: { name: 'asc' },
    });
  }

  async queueIdsFor(userId: string): Promise<number[]> {
    return (await this.queuesFor(userId)).map((q) => q.id);
  }

  /** Active members of a queue, for transfer pickers. */
  async activeMembers(queueId: number) {
    const members = await this.prisma.ticket_queue_members.findMany({
      where: { queue_id: queueId, user: { is_active: true, deleted_at: null } },
      orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
      select: { user: { select: { id: true, full_name: true, username: true, role: true } } },
    });
    return members.map((m) => m.user);
  }

  // ─── Health ────────────────────────────────────────────────────────────────

  async health(): Promise<RoutingIssue[]> {
    const [rules, queues] = await Promise.all([
      this.prisma.ticket_routing_rules.findMany({
        where: { is_active: true },
        include: ruleInclude,
        orderBy: { id: 'asc' },
      }),
      this.prisma.ticket_queues.findMany({ where: { is_active: true }, include: queueInclude }),
    ]);
    const issues: RoutingIssue[] = [];
    const scopes: ScopeCache = new Map();

    for (const rule of rules) {
      if (!rule.target_user && !rule.target_queue) {
        issues.push({ severity: 'error', code: 'RULE_NO_TARGET', rule_id: rule.id, message: `Rule "${rule.name}" has no target.` });
        continue;
      }
      const user = rule.target_user;
      if (user && (!user.is_active || user.deleted_at)) {
        issues.push({
          severity: 'error',
          code: 'RULE_TARGET_INACTIVE',
          rule_id: rule.id,
          message: `Rule "${rule.name}" sends tickets to ${user.full_name}, who is inactive. Matching tickets fall through to the next rule.`,
        });
      } else if (user && rule.campus_id != null) {
        const scope = await this.scopeOf(user.id, scopes);
        const sample = { campus_id: rule.campus_id, class_id: rule.class_ids[0] ?? null, segment_id: rule.segment_id };
        if (!this.scope.canSeeStudent({ role: user.role, scope }, sample)) {
          issues.push({
            severity: 'warning',
            code: 'RULE_TARGET_OUT_OF_SCOPE',
            rule_id: rule.id,
            message: `Rule "${rule.name}" targets ${user.full_name}, whose access scope does not cover the students it matches.`,
          });
        }
      }
    }

    for (const queue of queues) {
      const active = queue.members.filter((m) => m.user.is_active && !m.user.deleted_at);
      if (active.length === 0) {
        issues.push({ severity: 'error', code: 'QUEUE_NO_ACTIVE_MEMBERS', queue_id: queue.id, message: `Queue "${queue.name}" has no active members.` });
      } else if (active.length === 1) {
        issues.push({
          severity: 'warning',
          code: 'QUEUE_SINGLE_MEMBER',
          queue_id: queue.id,
          message: `Queue "${queue.name}" depends on one person (${active[0].user.full_name}). Add a backup.`,
        });
      }
    }

    for (const category of Object.values(TicketCategory)) {
      if (!queues.some((q) => q.category === category && q.is_fallback)) {
        issues.push({
          severity: 'error',
          code: 'NO_FALLBACK_QUEUE',
          message: `No active fallback queue for ${category} tickets. Unmatched tickets will sit unassigned.`,
        });
      }
    }

    issues.push(...(await this.uncoveredPlacements(rules, scopes)));
    return issues;
  }

  /**
   * Campus/class pairs with students on roll where a general ticket about the
   * child would not reach a named person or a queue through any rule, so it can
   * only land in the fallback.
   */
  private async uncoveredPlacements(rules: RuleRow[], scopes: ScopeCache): Promise<RoutingIssue[]> {
    const placements = await this.prisma.students.groupBy({
      by: ['campus_id', 'class_id'],
      where: { deleted_at: null, campus_id: { not: null }, class_id: { not: null } },
      _count: { _all: true },
    });
    if (placements.length === 0) return [];
    const [classes, campuses] = await Promise.all([
      this.prisma.classes.findMany({ select: { id: true, description: true, segment_id: true } }),
      this.prisma.campuses.findMany({ select: { id: true, campus_name: true } }),
    ]);
    const classById = new Map(classes.map((c) => [c.id, c]));
    const campusName = new Map(campuses.map((c) => [c.id, c.campus_name]));

    const issues: RoutingIssue[] = [];
    for (const p of placements) {
      const cls = classById.get(p.class_id!);
      const subject: RoutingSubject = {
        category: TicketCategory.GENERAL,
        student: { campus_id: p.campus_id, class_id: p.class_id, segment_id: cls?.segment_id ?? null },
      };
      let routed = false;
      for (const rule of orderMatchingRules(rules, subject)) {
        if ((await this.evaluateRuleTarget(rule, subject, scopes)).ok) {
          routed = true;
          break;
        }
      }
      if (!routed) {
        issues.push({
          severity: 'warning',
          code: 'UNCOVERED_PLACEMENT',
          campus_id: p.campus_id!,
          class_id: p.class_id!,
          message: `${campusName.get(p.campus_id!) ?? `Campus ${p.campus_id}`} · ${cls?.description ?? `Class ${p.class_id}`} (${p._count._all} students): general tickets about a child go to the fallback queue.`,
        });
      }
    }
    return issues;
  }

  /** Rules and queues that depend on this person, for deactivation warnings. */
  async userImpact(userId: string) {
    const [rules, memberships] = await Promise.all([
      this.prisma.ticket_routing_rules.findMany({
        where: { target_user_id: userId, is_active: true },
        select: { id: true, name: true },
      }),
      this.prisma.ticket_queue_members.findMany({
        where: { user_id: userId, queue: { is_active: true } },
        select: {
          queue: {
            select: {
              id: true,
              name: true,
              members: { select: { user: { select: { id: true, is_active: true, deleted_at: true } } } },
            },
          },
        },
      }),
    ]);
    const queues = memberships.map(({ queue }) => {
      const othersActive = queue.members.filter(
        (m) => m.user.id !== userId && m.user.is_active && !m.user.deleted_at,
      ).length;
      return { id: queue.id, name: queue.name, last_active_member: othersActive === 0 };
    });
    return { rules, queues, affected: rules.length > 0 || queues.some((q) => q.last_active_member) };
  }
}

function describeSteps(steps: RoutingStep[]): string {
  return steps
    .map((s) => `${s.rule_name}: ${s.outcome === 'routed' ? 'routed' : 'skipped'} ${s.reason}`)
    .join('; ')
    .slice(0, 500);
}
