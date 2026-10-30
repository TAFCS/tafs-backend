import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, TicketCategory, TicketFlowStatus } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { TicketRoutingService } from '../routing/ticket-routing.service';
import {
  defaultTree,
  diffTrees,
  findLeafBySubtopic,
  indexTree,
  laneSettings,
  parentView,
  structureIssues,
  ticketLeaves,
  ticketSettings,
  validateTree,
  walkPath,
  type ValidationContext,
} from './flow-tree';
import {
  DEFAULT_MIN_LENGTH,
  FLOW_COLORS,
  FLOW_ICONS,
  FLOW_LIMITS,
  FLOW_NODE_TYPES,
  FLOW_SCHEMA,
  FLOW_SCREENS,
  type FlowPathStep,
  type FlowPlacement,
  type FlowTree,
} from './flow.types';

/** A ticket sent against a version that was just replaced still goes through for this long. */
const VERSION_GRACE_MS = 24 * 60 * 60 * 1000;
const CACHE_MS = 30_000;
const AUDIT_ENTITY = 'SUPPORT_TICKET_FLOW';

/** What a submitted path resolves to: everything createTicket needs to store and route it. */
export interface FlowOrigin {
  category: TicketCategory;
  subtopic: string;
  lane_id: number | null;
  flow_version: number | null;
  leaf_node_key: string | null;
  flow_path: FlowPathStep[] | null;
  path_keys: string[];
  leaf_queue_id: number | null;
  lane_fallback_queue_id: number | null;
  min_length: number;
}

type FlowRow = Prisma.ticket_flowsGetPayload<object>;

@Injectable()
export class TicketFlowService {
  private readonly logger = new Logger(TicketFlowService.name);
  private cache: { at: number; row: FlowRow } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly routing: TicketRoutingService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  // ─── Published flow ────────────────────────────────────────────────────────

  /**
   * The published flow. The very first call seeds version 1 (today's wizard)
   * so the feature needs no data migration and parents see no change.
   */
  async published(): Promise<FlowRow> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS)
      return this.cache.row;
    let row = await this.prisma.ticket_flows.findFirst({
      where: { status: TicketFlowStatus.PUBLISHED },
    });
    if (!row) row = await this.seed();
    this.cache = { at: Date.now(), row };
    return row;
  }

  private async seed(): Promise<FlowRow> {
    const tree = defaultTree();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const any = await tx.ticket_flows.count();
        if (any > 0) {
          // Every version is archived (should not happen): republish the newest.
          const latest = await tx.ticket_flows.findFirstOrThrow({
            orderBy: { version: 'desc' },
          });
          return tx.ticket_flows.update({
            where: { id: latest.id },
            data: {
              status: TicketFlowStatus.PUBLISHED,
              archived_at: null,
              published_at: new Date(),
              published_by: 'system',
            },
          });
        }
        const row = await tx.ticket_flows.create({
          data: {
            version: 1,
            status: TicketFlowStatus.PUBLISHED,
            tree: tree as unknown as Prisma.InputJsonValue,
            notes: 'Version 1: the original General and Fees questions',
            created_by: 'system',
            updated_by: 'system',
            published_at: new Date(),
            published_by: 'system',
          },
        });
        await this.syncLanes(tx, tree);
        return row;
      });
    } catch (e) {
      // Another request seeded it first.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        return this.prisma.ticket_flows.findFirstOrThrow({
          where: { status: TicketFlowStatus.PUBLISHED },
        });
      }
      throw e;
    }
  }

  /** Lane rows follow the published tree: upsert every lane, switch off the rest. */
  private async syncLanes(tx: Prisma.TransactionClient, tree: FlowTree) {
    const keys: string[] = [];
    for (const [i, lane] of tree.lanes.entries()) {
      const ls = laneSettings(lane);
      const data = {
        name: lane.label.slice(0, 80),
        name_ur: lane.label_ur?.slice(0, 80) || null,
        icon: lane.icon || 'help',
        color: ls.color,
        legacy_category: ls.legacy_category as TicketCategory,
        sort_order: i,
        is_active: true,
      };
      await tx.ticket_lanes.upsert({
        where: { key: lane.key },
        create: { key: lane.key, ...data },
        update: data,
      });
      keys.push(lane.key);
    }
    await tx.ticket_lanes.updateMany({
      where: { key: { notIn: keys } },
      data: { is_active: false },
    });
  }

  private async familyPlacements(familyId: number) {
    const students = await this.prisma.students.findMany({
      where: { family_id: familyId, deleted_at: null },
      select: {
        cc: true,
        full_name: true,
        campus_id: true,
        class_id: true,
        photograph_url: true,
        classes: { select: { description: true, segment_id: true } },
        sections: { select: { description: true } },
      },
      orderBy: { cc: 'asc' },
    });
    return students.map((s) => ({
      student_id: s.cc,
      full_name: s.full_name,
      class_name: s.classes?.description ?? null,
      section_name: s.sections?.description ?? null,
      photograph_url: s.photograph_url,
      campus_id: s.campus_id,
      class_id: s.class_id,
      segment_id: s.classes?.segment_id ?? null,
    }));
  }

  /** The flow as the family's app walks it. */
  async parentFlow(familyId: number) {
    const [row, children] = await Promise.all([
      this.published(),
      this.familyPlacements(familyId),
    ]);
    const tree = parentView(row.tree as unknown as FlowTree, children);
    return {
      version: row.version,
      schema: tree.schema,
      lanes: tree.lanes,
      children,
    };
  }

  /** Lanes for staff filters and chips: every lane ever published, active first. */
  lanes() {
    return this.prisma.ticket_lanes.findMany({
      select: {
        id: true,
        key: true,
        name: true,
        name_ur: true,
        icon: true,
        color: true,
        legacy_category: true,
        is_active: true,
      },
      orderBy: [{ is_active: 'desc' }, { sort_order: 'asc' }, { id: 'asc' }],
    });
  }

  // ─── Resolving a ticket's origin ───────────────────────────────────────────

  /** A new-app ticket: re-walk the submitted path against the version the app used. */
  async resolvePath(
    familyId: number,
    flowVersion: number,
    pathKeys: string[],
    student: FlowPlacement | null,
  ): Promise<FlowOrigin> {
    const current = await this.published();
    let row: FlowRow | null = current;
    if (flowVersion !== current.version) {
      row = await this.prisma.ticket_flows.findUnique({
        where: { version: flowVersion },
      });
      const fresh =
        row?.archived_at &&
        Date.now() - row.archived_at.getTime() < VERSION_GRACE_MS;
      if (!row || row.status !== TicketFlowStatus.ARCHIVED || !fresh) {
        throw new ConflictException({
          code: 'FLOW_CHANGED',
          message: 'The help options were updated. Please choose again.',
        });
      }
    }
    const family = (await this.familyPlacements(familyId)).map(
      ({ campus_id, class_id, segment_id }) => ({
        campus_id,
        class_id,
        segment_id,
      }),
    );
    const tree = row.tree as unknown as FlowTree;
    const walk = walkPath(tree, pathKeys, student, family);
    if (!walk.ok) {
      if (walk.code === 'PATH_CHANGED')
        throw new ConflictException({
          code: 'FLOW_CHANGED',
          message: walk.message,
        });
      throw new BadRequestException({ code: walk.code, message: walk.message });
    }
    const ls = laneSettings(walk.lane);
    const ts = ticketSettings(walk.leaf);
    const lane = await this.prisma.ticket_lanes.findUnique({
      where: { key: walk.lane.key },
      select: { id: true },
    });
    return {
      category: ls.legacy_category as TicketCategory,
      subtopic: walk.leaf.label.slice(0, 100),
      lane_id: lane?.id ?? null,
      flow_version: row.version,
      leaf_node_key: walk.leaf.key,
      flow_path: walk.steps,
      path_keys: walk.steps.map((s) => s.key),
      leaf_queue_id: ts.queue_id ?? null,
      lane_fallback_queue_id: ls.fallback_queue_id ?? null,
      min_length: ts.min_length ?? DEFAULT_MIN_LENGTH,
    };
  }

  /**
   * An old-app ticket (category + subtopic text): find its lane and, when the
   * text still matches a leaf, its path, so node rules and lane chips apply.
   * Never fails: the ticket is created either way.
   */
  async legacyOrigin(
    category: TicketCategory,
    subtopic: string,
    aboutChild: boolean,
  ): Promise<FlowOrigin> {
    const base: FlowOrigin = {
      category,
      subtopic,
      lane_id: null,
      flow_version: null,
      leaf_node_key: null,
      flow_path: null,
      path_keys: [],
      leaf_queue_id: null,
      lane_fallback_queue_id: null,
      min_length: DEFAULT_MIN_LENGTH,
    };
    try {
      const row = await this.published();
      const tree = row.tree as unknown as FlowTree;
      const hit = findLeafBySubtopic(tree, category, subtopic, aboutChild);
      const laneKey =
        hit?.lane.key ??
        tree.lanes.find((l) => laneSettings(l).legacy_category === category)
          ?.key ??
        null;
      const lane = laneKey
        ? await this.prisma.ticket_lanes.findUnique({
            where: { key: laneKey },
            select: { id: true },
          })
        : null;
      if (!hit) return { ...base, lane_id: lane?.id ?? null };
      const idx = indexTree(tree);
      return {
        ...base,
        lane_id: lane?.id ?? null,
        flow_version: row.version,
        leaf_node_key: hit.leaf.key,
        flow_path: hit.path.map((k) => {
          const n = idx.get(k)!.node;
          return { key: n.key, type: n.type, label: n.label };
        }),
        path_keys: hit.path,
        leaf_queue_id: ticketSettings(hit.leaf).queue_id ?? null,
        lane_fallback_queue_id:
          laneSettings(hit.lane).fallback_queue_id ?? null,
      };
    } catch (e) {
      this.logger.warn(
        `Legacy ticket origin lookup failed: ${(e as Error).message}`,
      );
      return base;
    }
  }

  // ─── Admin ─────────────────────────────────────────────────────────────────

  private assertAdmin(staff: IJwtStaffPayload) {
    if (staff.role !== 'SUPER_ADMIN')
      throw new ForbiddenException(
        'Only super admins can edit the ticket flow',
      );
  }

  private async validationContext(): Promise<ValidationContext> {
    const queues = await this.prisma.ticket_queues.findMany({
      select: {
        id: true,
        name: true,
        category: true,
        is_active: true,
        is_fallback: true,
      },
    });
    return { queues: new Map(queues.map((q) => [q.id, q])) };
  }

  /** Everything the builder needs in one call. */
  async overview(staff: IJwtStaffPayload) {
    this.assertAdmin(staff);
    const published = await this.published();
    const [draft, queues, campuses, segments, classes, rules] =
      await Promise.all([
        this.prisma.ticket_flows.findFirst({
          where: { status: TicketFlowStatus.DRAFT },
        }),
        this.prisma.ticket_queues.findMany({
          select: {
            id: true,
            name: true,
            category: true,
            is_active: true,
            is_fallback: true,
          },
          orderBy: { name: 'asc' },
        }),
        this.prisma.campuses.findMany({
          select: { id: true, campus_name: true },
          orderBy: { id: 'asc' },
        }),
        this.prisma.segments.findMany({
          select: { id: true, name: true },
          orderBy: { display_order: 'asc' },
        }),
        this.prisma.classes.findMany({
          select: { id: true, description: true, segment_id: true },
          orderBy: { id: 'asc' },
        }),
        this.prisma.ticket_routing_rules.findMany({
          where: { is_active: true },
          select: {
            id: true,
            name: true,
            category: true,
            subtopic: true,
            node_key: true,
          },
        }),
      ]);
    return {
      published: this.versionSummary(published),
      published_tree: published.tree,
      draft: draft
        ? {
            ...this.versionSummary(draft),
            tree: draft.tree,
            lock_version: draft.lock_version,
          }
        : null,
      options: {
        queues,
        campuses,
        segments,
        classes,
        rules,
        node_types: FLOW_NODE_TYPES,
        screens: FLOW_SCREENS,
        icons: FLOW_ICONS,
        colors: FLOW_COLORS,
        limits: FLOW_LIMITS,
        default_min_length: DEFAULT_MIN_LENGTH,
      },
    };
  }

  private versionSummary(row: FlowRow) {
    return {
      version: row.version,
      status: row.status,
      notes: row.notes,
      created_at: row.created_at,
      created_by: row.created_by,
      updated_at: row.updated_at,
      updated_by: row.updated_by,
      published_at: row.published_at,
      published_by: row.published_by,
      archived_at: row.archived_at,
      created_from: row.created_from,
    };
  }

  /** The open draft, created from the published flow (or a given version) when there is none. */
  async openDraft(staff: IJwtStaffPayload, fromVersion?: number) {
    this.assertAdmin(staff);
    const existing = await this.prisma.ticket_flows.findFirst({
      where: { status: TicketFlowStatus.DRAFT },
    });
    if (existing && fromVersion == null) return this.draftView(existing);
    const source =
      fromVersion != null
        ? await this.prisma.ticket_flows.findUnique({
            where: { version: fromVersion },
          })
        : await this.published();
    if (!source) throw new NotFoundException(`No flow version ${fromVersion}`);
    const created = await this.prisma.$transaction(async (tx) => {
      if (existing)
        await tx.ticket_flows.delete({ where: { id: existing.id } });
      const max = await tx.ticket_flows.aggregate({ _max: { version: true } });
      return tx.ticket_flows.create({
        data: {
          version: (max._max.version ?? 0) + 1,
          status: TicketFlowStatus.DRAFT,
          tree: source.tree as Prisma.InputJsonValue,
          created_from: source.version,
          created_by: staff.username,
          updated_by: staff.username,
        },
      });
    });
    if (fromVersion != null) {
      this.audit(
        staff,
        `v${created.version}`,
        'RESTORED',
        `Draft v${created.version} started from version ${fromVersion}`,
      );
    }
    return this.draftView(created);
  }

  private async draftView(row: FlowRow) {
    const issues = validateTree(
      row.tree as unknown as FlowTree,
      await this.validationContext(),
    );
    return {
      ...this.versionSummary(row),
      tree: row.tree,
      lock_version: row.lock_version,
      issues,
    };
  }

  /** Save the whole draft tree. Optimistic lock: a stale lock_version is refused. */
  async saveDraft(staff: IJwtStaffPayload, tree: unknown, lockVersion: number) {
    this.assertAdmin(staff);
    const structural = structureIssues(tree).filter(
      (i) => i.severity === 'error',
    );
    if (structural.length > 0) {
      throw new BadRequestException({
        message: structural[0].message,
        issues: structural,
      });
    }
    const draft = await this.prisma.ticket_flows.findFirst({
      where: { status: TicketFlowStatus.DRAFT },
    });
    if (!draft)
      throw new NotFoundException('There is no draft to save. Open one first.');
    const normalized = {
      schema: FLOW_SCHEMA,
      lanes: (tree as FlowTree).lanes,
    } satisfies FlowTree;
    const res = await this.prisma.ticket_flows.updateMany({
      where: {
        id: draft.id,
        lock_version: lockVersion,
        status: TicketFlowStatus.DRAFT,
      },
      data: {
        tree: normalized as unknown as Prisma.InputJsonValue,
        lock_version: { increment: 1 },
        updated_by: staff.username,
      },
    });
    if (res.count === 0) {
      throw new ConflictException({
        code: 'DRAFT_CHANGED',
        message: `${draft.updated_by ?? 'Someone'} changed this draft since you opened it. Reload to see their changes.`,
      });
    }
    const saved = await this.prisma.ticket_flows.findUniqueOrThrow({
      where: { id: draft.id },
    });
    return this.draftView(saved);
  }

  async validateDraft(staff: IJwtStaffPayload) {
    this.assertAdmin(staff);
    const draft = await this.requireDraft();
    const published = await this.published();
    return {
      issues: validateTree(
        draft.tree as unknown as FlowTree,
        await this.validationContext(),
      ),
      diff: diffTrees(
        published.tree as unknown as FlowTree,
        draft.tree as unknown as FlowTree,
      ),
    };
  }

  private async requireDraft() {
    const draft = await this.prisma.ticket_flows.findFirst({
      where: { status: TicketFlowStatus.DRAFT },
    });
    if (!draft) throw new NotFoundException('There is no draft');
    return draft;
  }

  async publish(
    staff: IJwtStaffPayload,
    notes: string | undefined,
    lockVersion: number,
  ) {
    this.assertAdmin(staff);
    const draft = await this.requireDraft();
    if (draft.lock_version !== lockVersion) {
      throw new ConflictException({
        code: 'DRAFT_CHANGED',
        message: 'The draft changed since you checked it. Review it again.',
      });
    }
    const tree = draft.tree as unknown as FlowTree;
    const issues = validateTree(tree, await this.validationContext());
    const errors = issues.filter((i) => i.severity === 'error');
    if (errors.length > 0) {
      throw new UnprocessableEntityException({
        message: `Fix ${errors.length} problem(s) before publishing`,
        issues: errors,
      });
    }
    const previous = await this.published();
    const diff = diffTrees(previous.tree as unknown as FlowTree, tree);
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.ticket_flows.updateMany({
        where: { status: TicketFlowStatus.PUBLISHED },
        data: { status: TicketFlowStatus.ARCHIVED, archived_at: now },
      });
      await tx.ticket_flows.update({
        where: { id: draft.id },
        data: {
          status: TicketFlowStatus.PUBLISHED,
          notes: notes?.trim().slice(0, 500) || null,
          published_at: now,
          published_by: staff.username,
          updated_by: staff.username,
        },
      });
      await this.syncLanes(tx, tree);
    });
    this.cache = null;
    this.audit(
      staff,
      `v${draft.version}`,
      'PUBLISHED',
      `Ticket flow v${draft.version} published${notes ? `: ${notes.slice(0, 200)}` : ''}`,
      previous.version,
      { version: draft.version, diff },
    );
    return { version: draft.version, diff };
  }

  async discardDraft(staff: IJwtStaffPayload) {
    this.assertAdmin(staff);
    const draft = await this.requireDraft();
    await this.prisma.ticket_flows.delete({ where: { id: draft.id } });
    return { discarded: draft.version };
  }

  async versions(staff: IJwtStaffPayload) {
    this.assertAdmin(staff);
    const rows = await this.prisma.ticket_flows.findMany({
      orderBy: { version: 'desc' },
      take: 100,
    });
    return rows.map((r) => this.versionSummary(r));
  }

  async version(staff: IJwtStaffPayload, version: number) {
    this.assertAdmin(staff);
    const row = await this.prisma.ticket_flows.findUnique({
      where: { version },
    });
    if (!row) throw new NotFoundException(`No flow version ${version}`);
    return { ...this.versionSummary(row), tree: row.tree };
  }

  /**
   * Where a ticket from this path would go, for a sample child (or no child).
   * Walks the draft when there is one, so the builder can test before publishing.
   */
  async previewRoute(
    staff: IJwtStaffPayload,
    pathKeys: string[],
    studentCc: number | null,
    useDraft: boolean,
  ) {
    this.assertAdmin(staff);
    const row =
      (useDraft &&
        (await this.prisma.ticket_flows.findFirst({
          where: { status: TicketFlowStatus.DRAFT },
        }))) ||
      (await this.published());
    const tree = row.tree as unknown as FlowTree;
    const { student, family, label } = await this.sampleStudent(studentCc);
    const walk = walkPath(tree, pathKeys, student, family);
    if (!walk.ok)
      throw new BadRequestException({ code: walk.code, message: walk.message });
    const ls = laneSettings(walk.lane);
    const decision = await this.routing.resolve({
      category: ls.legacy_category as TicketCategory,
      subtopic: walk.leaf.label.slice(0, 100),
      student,
      path_keys: walk.steps.map((s) => s.key),
      leaf_queue_id: ticketSettings(walk.leaf).queue_id ?? null,
      lane_fallback_queue_id: ls.fallback_queue_id ?? null,
    });
    return {
      version: row.version,
      student: label,
      path: walk.steps,
      ...decision,
    };
  }

  /** Every ticket leaf and where it goes for one sample child: the quickest way to spot fallbacks. */
  async routeAll(
    staff: IJwtStaffPayload,
    studentCc: number | null,
    useDraft: boolean,
  ) {
    this.assertAdmin(staff);
    const row =
      (useDraft &&
        (await this.prisma.ticket_flows.findFirst({
          where: { status: TicketFlowStatus.DRAFT },
        }))) ||
      (await this.published());
    const tree = row.tree as unknown as FlowTree;
    const { student, family, label } = await this.sampleStudent(studentCc);
    const out: Array<Record<string, unknown>> = [];
    for (const { leaf, lane, path, labels } of ticketLeaves(tree)) {
      const walk = walkPath(tree, path, student, family);
      if (!walk.ok) {
        out.push({
          leaf_key: leaf.key,
          labels,
          available: false,
          reason: walk.message,
        });
        continue;
      }
      const ls = laneSettings(lane);
      const d = await this.routing.resolve({
        category: ls.legacy_category as TicketCategory,
        subtopic: leaf.label.slice(0, 100),
        student,
        path_keys: path,
        leaf_queue_id: ticketSettings(leaf).queue_id ?? null,
        lane_fallback_queue_id: ls.fallback_queue_id ?? null,
      });
      out.push({
        leaf_key: leaf.key,
        labels,
        available: true,
        target: d.target,
        rule_id: d.ruleId,
        note: d.note,
        status: d.status,
      });
    }
    return { version: row.version, student: label, leaves: out };
  }

  private async sampleStudent(cc: number | null) {
    if (cc == null)
      return { student: null, family: [] as FlowPlacement[], label: null };
    const row = await this.prisma.students.findFirst({
      where: { cc, deleted_at: null },
      select: {
        full_name: true,
        family_id: true,
        campus_id: true,
        class_id: true,
        classes: { select: { description: true, segment_id: true } },
        campuses: { select: { campus_name: true } },
      },
    });
    if (!row) throw new NotFoundException(`No student with CC ${cc}`);
    const student = {
      campus_id: row.campus_id,
      class_id: row.class_id,
      segment_id: row.classes?.segment_id ?? null,
    };
    const family = row.family_id
      ? (await this.familyPlacements(row.family_id)).map(
          ({ campus_id, class_id, segment_id }) => ({
            campus_id,
            class_id,
            segment_id,
          }),
        )
      : [student];
    return {
      student,
      family,
      label: [
        row.full_name,
        row.campuses?.campus_name,
        row.classes?.description,
      ]
        .filter(Boolean)
        .join(' · '),
    };
  }

  private audit(
    staff: IJwtStaffPayload,
    entityId: string,
    action: string,
    note: string,
    before?: unknown,
    after?: unknown,
  ) {
    void this.auditLogs.log({
      entity_type: AUDIT_ENTITY,
      entity_id: entityId,
      action,
      changed_by: staff.username,
      old_value: before != null ? JSON.stringify(before).slice(0, 4000) : null,
      new_value: after != null ? JSON.stringify(after).slice(0, 4000) : null,
      note,
    });
  }
}
