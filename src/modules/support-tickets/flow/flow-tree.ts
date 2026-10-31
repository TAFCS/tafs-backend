import { ORIGINATION_OPTIONS } from '../../../common/support-ticket-routing';
import {
  DEFAULT_MIN_LENGTH,
  FLOW_ICONS,
  FLOW_LIMITS,
  FLOW_NODE_TYPES,
  FLOW_SCHEMA,
  FLOW_SCREENS,
  type FlowConditions,
  type FlowIssue,
  type FlowNode,
  type FlowPathStep,
  type FlowPlacement,
  type FlowTree,
  type LaneSettings,
  type PickChildSettings,
  type TicketSettings,
} from './flow.types';

// Pure helpers over a flow tree: no database. The service feeds them queues and
// placements; the specs exercise them directly.

const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export interface IndexedNode {
  node: FlowNode;
  parent: FlowNode | null;
  lane: FlowNode;
  depth: number;
  /** Keys from the lane down to (and including) this node. */
  path: string[];
}

export function indexTree(tree: FlowTree): Map<string, IndexedNode> {
  const out = new Map<string, IndexedNode>();
  const visit = (
    node: FlowNode,
    parent: FlowNode | null,
    lane: FlowNode,
    depth: number,
    path: string[],
  ) => {
    const here = [...path, node.key];
    if (!out.has(node.key))
      out.set(node.key, { node, parent, lane, depth, path: here });
    for (const child of node.children ?? [])
      visit(child, node, lane, depth + 1, here);
  };
  for (const lane of tree.lanes ?? []) visit(lane, null, lane, 0, []);
  return out;
}

export function laneSettings(lane: FlowNode): LaneSettings {
  return (lane.settings ?? {}) as unknown as LaneSettings;
}

export function ticketSettings(node: FlowNode): TicketSettings {
  return (node.settings ?? {}) as TicketSettings;
}

function pickSettings(node: FlowNode): PickChildSettings {
  return (node.settings ?? {}) as unknown as PickChildSettings;
}

// ─── Conditions ──────────────────────────────────────────────────────────────

export interface ConditionContext {
  /** The child picked at a PICK_CHILD, or null for "not about a child". */
  child: FlowPlacement | null;
  /** Whether the walk has passed a PICK_CHILD yet. */
  pickedChild: boolean;
  /** Every child in the family: placement conditions before a pick match any of them. */
  family: FlowPlacement[];
}

function placementMatches(cond: FlowConditions, p: FlowPlacement): boolean {
  if (cond.campus_ids?.length && !cond.campus_ids.includes(p.campus_id ?? -1))
    return false;
  if (
    cond.segment_ids?.length &&
    !cond.segment_ids.includes(p.segment_id ?? -1)
  )
    return false;
  if (cond.class_ids?.length && !cond.class_ids.includes(p.class_id ?? -1))
    return false;
  return true;
}

function hasPlacement(cond: FlowConditions): boolean {
  return !!(
    cond.campus_ids?.length ||
    cond.segment_ids?.length ||
    cond.class_ids?.length
  );
}

/** Whether a node shows for this family at this point of the walk. */
export function nodeVisible(node: FlowNode, ctx: ConditionContext): boolean {
  const cond = node.conditions;
  if (!cond) return true;
  if (cond.child) {
    if (!ctx.pickedChild) return false;
    if (cond.child === 'WITH' && !ctx.child) return false;
    if (cond.child === 'WITHOUT' && ctx.child) return false;
  }
  if (!hasPlacement(cond)) return true;
  const subjects = ctx.child ? [ctx.child] : ctx.family;
  return subjects.some((p) => placementMatches(cond, p));
}

// ─── Walking a path ──────────────────────────────────────────────────────────

export type WalkResult =
  | {
      ok: true;
      lane: FlowNode;
      leaf: FlowNode;
      steps: FlowPathStep[];
      pickedChild: boolean;
    }
  | { ok: false; code: string; message: string };

/**
 * Re-walk the path a parent submitted against a flow version. Every key must be
 * a visible child of the one before; a child may only be named after a
 * PICK_CHILD; the path must end at a TICKET leaf.
 */
export function walkPath(
  tree: FlowTree,
  keys: string[],
  student: FlowPlacement | null,
  family: FlowPlacement[],
): WalkResult {
  if (keys.length === 0)
    return {
      ok: false,
      code: 'EMPTY_PATH',
      message: 'Choose what this is about',
    };
  let options: FlowNode[] = tree.lanes ?? [];
  const ctx: ConditionContext = { child: null, pickedChild: false, family };
  const steps: FlowPathStep[] = [];
  let lane: FlowNode | null = null;
  let current: FlowNode | null = null;

  for (let i = 0; i < keys.length; i++) {
    const node = options.find((n) => n.key === keys[i]);
    if (!node || !nodeVisible(node, ctx)) {
      return {
        ok: false,
        code: 'PATH_CHANGED',
        message: 'This option is no longer available. Please choose again.',
      };
    }
    if (i === 0) {
      if (node.type !== 'LANE')
        return {
          ok: false,
          code: 'BAD_PATH',
          message: 'A path starts with a lane',
        };
      lane = node;
    }
    steps.push({ key: node.key, type: node.type, label: node.label });
    current = node;
    if (node.type === 'PICK_CHILD') {
      if (ctx.pickedChild)
        return {
          ok: false,
          code: 'BAD_PATH',
          message: 'The child is chosen once',
        };
      if (!student && !pickSettings(node).allow_none) {
        return {
          ok: false,
          code: 'CHILD_REQUIRED',
          message: 'Choose which child this is about',
        };
      }
      ctx.pickedChild = true;
      ctx.child = student;
    }
    if (
      (node.type === 'TICKET' || node.type === 'SCREEN') &&
      i !== keys.length - 1
    ) {
      return {
        ok: false,
        code: 'BAD_PATH',
        message: 'The path continues past a leaf',
      };
    }
    options = node.children ?? [];
  }

  if (!current || current.type !== 'TICKET') {
    return {
      ok: false,
      code: 'NOT_A_TICKET',
      message: 'This option does not open a ticket',
    };
  }
  if (student && !ctx.pickedChild) {
    return {
      ok: false,
      code: 'BAD_PATH',
      message: 'This option is not about a child',
    };
  }
  return {
    ok: true,
    lane: lane!,
    leaf: current,
    steps,
    pickedChild: ctx.pickedChild,
  };
}

// ─── Validation ──────────────────────────────────────────────────────────────

export interface ValidationContext {
  queues: Map<
    number,
    {
      name: string;
      category: 'GENERAL' | 'FINANCIAL';
      is_active: boolean;
      is_fallback: boolean;
    }
  >;
}

/**
 * Problems that make a tree unusable or unsafe to store at all (bad JSON shape,
 * duplicate keys, unknown types). Saving a draft rejects these; everything else
 * is a publish-time issue so a half-built draft can still be saved.
 */
export function structureIssues(tree: unknown): FlowIssue[] {
  const issues: FlowIssue[] = [];
  const err = (code: string, message: string, node_key?: string) =>
    issues.push({ severity: 'error', code, message, node_key });
  if (
    !tree ||
    typeof tree !== 'object' ||
    !Array.isArray((tree as FlowTree).lanes)
  ) {
    err('BAD_TREE', 'The flow must have a list of lanes');
    return issues;
  }
  const t = tree as FlowTree;
  if (t.lanes.length > FLOW_LIMITS.maxLanes)
    err('TOO_MANY_LANES', `At most ${FLOW_LIMITS.maxLanes} lanes`);
  const seen = new Set<string>();
  let count = 0;
  const visit = (node: FlowNode, depth: number, isRoot: boolean) => {
    count++;
    if (!node || typeof node !== 'object')
      return err('BAD_NODE', 'A step is malformed');
    const key = typeof node.key === 'string' ? node.key : '';
    if (!KEY_RE.test(key))
      err('BAD_KEY', `Step key "${key}" is invalid`, key || undefined);
    else if (seen.has(key))
      err('DUPLICATE_KEY', `Step key "${key}" is used twice`, key);
    seen.add(key);
    if (!FLOW_NODE_TYPES.includes(node.type))
      err('UNKNOWN_TYPE', `Unknown step type "${String(node.type)}"`, key);
    if (isRoot && node.type !== 'LANE')
      err('ROOT_NOT_LANE', 'Only lanes can sit at the top', key);
    if (!isRoot && node.type === 'LANE')
      err('NESTED_LANE', 'A lane cannot sit inside another step', key);
    if (typeof node.label !== 'string' || !node.label.trim())
      err('NO_LABEL', 'Every step needs a label', key);
    else if (node.label.length > FLOW_LIMITS.labelLength) {
      err(
        'LABEL_TOO_LONG',
        `Labels are at most ${FLOW_LIMITS.labelLength} characters`,
        key,
      );
    }
    if (node.label_ur && node.label_ur.length > FLOW_LIMITS.labelLength) {
      err(
        'LABEL_TOO_LONG',
        `Labels are at most ${FLOW_LIMITS.labelLength} characters`,
        key,
      );
    }
    if (depth > FLOW_LIMITS.maxDepth)
      err('TOO_DEEP', `At most ${FLOW_LIMITS.maxDepth} steps deep`, key);
    const children = node.children ?? [];
    if (!Array.isArray(children))
      return err('BAD_NODE', 'Children must be a list', key);
    if (
      (node.type === 'TICKET' || node.type === 'SCREEN') &&
      children.length > 0
    ) {
      err(
        'LEAF_HAS_CHILDREN',
        'A ticket or screen step ends the flow, so it cannot have steps under it',
        key,
      );
    }
    if (children.length > FLOW_LIMITS.maxChildren) {
      err(
        'TOO_MANY_CHILDREN',
        `At most ${FLOW_LIMITS.maxChildren} answers under one step`,
        key,
      );
    }
    for (const child of children) visit(child, depth + 1, false);
  };
  for (const lane of t.lanes) visit(lane, 0, true);
  if (count > FLOW_LIMITS.maxNodes)
    err('TOO_MANY_NODES', `At most ${FLOW_LIMITS.maxNodes} steps in the flow`);
  return issues;
}

/** Everything checked before publishing: structure plus completeness and routing. */
export function validateTree(
  tree: FlowTree,
  ctx: ValidationContext,
): FlowIssue[] {
  const issues = structureIssues(tree);
  if (issues.some((i) => i.code === 'BAD_TREE')) return issues;
  const err = (code: string, message: string, node_key?: string) =>
    issues.push({ severity: 'error', code, message, node_key });
  const warn = (code: string, message: string, node_key?: string) =>
    issues.push({ severity: 'warning', code, message, node_key });

  if (tree.lanes.length === 0) err('NO_LANES', 'Add at least one lane');
  const icons = new Set<string>(FLOW_ICONS);
  const screens = new Set<string>(FLOW_SCREENS.map((s) => s.key));
  const hasUrdu = [...indexTree(tree).values()].some((x) => !!x.node.label_ur);

  const visit = (node: FlowNode, lane: FlowNode, pickedAbove: boolean) => {
    const s = node.settings ?? {};
    const children = node.children ?? [];
    const name = `"${node.label}"`;
    if (node.icon && !icons.has(node.icon))
      warn(
        'UNKNOWN_ICON',
        `${name} uses an icon the apps may not have`,
        node.key,
      );
    if (hasUrdu && !node.label_ur)
      warn('NO_URDU', `${name} has no Urdu label`, node.key);
    if (node.conditions?.child && !pickedAbove) {
      err(
        'CHILD_CONDITION_WITHOUT_PICK',
        `${name} depends on the child choice, but no "Pick a child" step comes before it`,
        node.key,
      );
    }
    if (
      node.conditions?.child &&
      node.conditions.child !== 'WITH' &&
      node.conditions.child !== 'WITHOUT'
    ) {
      err('BAD_CONDITION', `${name} has an invalid child condition`, node.key);
    }

    switch (node.type) {
      case 'LANE': {
        const ls = s as unknown as LaneSettings;
        if (
          ls.legacy_category !== 'GENERAL' &&
          ls.legacy_category !== 'FINANCIAL'
        ) {
          err(
            'LANE_NO_CATEGORY',
            `Lane ${name} needs a category (General or Fees)`,
            node.key,
          );
        }
        if (!ls.color || !HEX_RE.test(ls.color))
          err('LANE_BAD_COLOR', `Lane ${name} needs a colour`, node.key);
        if (!node.icon)
          warn('LANE_NO_ICON', `Lane ${name} has no icon`, node.key);
        if (ls.fallback_queue_id != null) {
          const q = ctx.queues.get(ls.fallback_queue_id);
          if (!q)
            err(
              'QUEUE_MISSING',
              `Lane ${name}'s fallback queue no longer exists`,
              node.key,
            );
          else if (q.category !== ls.legacy_category) {
            err(
              'QUEUE_CATEGORY',
              `Lane ${name}'s fallback queue ${q.name} belongs to the other category`,
              node.key,
            );
          } else if (!q.is_active)
            warn(
              'QUEUE_INACTIVE',
              `Lane ${name}'s fallback queue ${q.name} is switched off`,
              node.key,
            );
        }
        if (children.length === 0)
          err('EMPTY_BRANCH', `Lane ${name} has no steps`, node.key);
        break;
      }
      case 'QUESTION':
        if (children.length === 0)
          err('EMPTY_BRANCH', `${name} has no answers under it`, node.key);
        break;
      case 'PICK_CHILD': {
        if (pickedAbove)
          err(
            'PICK_TWICE',
            `${name} asks for the child a second time on the same path`,
            node.key,
          );
        if (children.length === 0)
          err('EMPTY_BRANCH', `${name} has no steps under it`, node.key);
        const ps = s as unknown as PickChildSettings;
        if (
          ps.allow_none &&
          children.length > 0 &&
          !children.some((c) => c.conditions?.child !== 'WITH')
        ) {
          err(
            'NONE_DEAD_END',
            `${name} offers "not about a child", but every answer under it needs a child`,
            node.key,
          );
        }
        if (
          children.length > 0 &&
          !children.some((c) => c.conditions?.child !== 'WITHOUT')
        ) {
          err(
            'CHILD_DEAD_END',
            `${name} lets the parent pick a child, but every answer under it is for "not about a child"`,
            node.key,
          );
        }
        break;
      }
      case 'INFO':
        if (typeof s.body !== 'string' || !s.body.trim())
          err('INFO_NO_BODY', `${name} has no text to show`, node.key);
        break;
      case 'TICKET': {
        const ts = s as TicketSettings;
        const ls = laneSettings(lane);
        if (
          ts.min_length != null &&
          (!Number.isInteger(ts.min_length) ||
            ts.min_length < 1 ||
            ts.min_length > 2000)
        ) {
          err(
            'BAD_MIN_LENGTH',
            `${name}: minimum length must be 1–2000 characters`,
            node.key,
          );
        }
        if (ts.queue_id != null) {
          const q = ctx.queues.get(ts.queue_id);
          if (!q)
            err(
              'QUEUE_MISSING',
              `${name} sends tickets to a queue that no longer exists`,
              node.key,
            );
          else if (q.category !== ls.legacy_category) {
            err(
              'QUEUE_CATEGORY',
              `${name} sends tickets to ${q.name}, which belongs to the other category`,
              node.key,
            );
          } else if (!q.is_active)
            warn(
              'QUEUE_INACTIVE',
              `${name} sends tickets to ${q.name}, which is switched off`,
              node.key,
            );
        }
        if (node.label.length > 100)
          warn(
            'SUBTOPIC_TRUNCATED',
            `${name} is cut to 100 characters on the ticket`,
            node.key,
          );
        break;
      }
      case 'SCREEN':
        if (typeof s.screen !== 'string' || !screens.has(s.screen)) {
          err(
            'UNKNOWN_SCREEN',
            `${name} opens a screen the apps do not have`,
            node.key,
          );
        }
        break;
    }

    // A lane with one step is the normal shape (lane → pick a child); only a
    // question with a single answer is worth flagging.
    if (children.length === 1 && node.type === 'QUESTION') {
      warn(
        'SINGLE_ANSWER',
        `${name} has one answer, so the app skips straight past it`,
        node.key,
      );
    }
    const labels = new Set<string>();
    for (const c of children) {
      const l = `${c.label?.trim().toLowerCase()}|${c.conditions?.child ?? ''}`;
      if (labels.has(l))
        err(
          'DUPLICATE_LABEL',
          `Two answers under ${name} are both called "${c.label}"`,
          c.key,
        );
      labels.add(l);
    }
    for (const c of children)
      visit(c, lane, pickedAbove || node.type === 'PICK_CHILD');
  };
  for (const lane of tree.lanes) visit(lane, lane, false);
  return issues;
}

// ─── Views ───────────────────────────────────────────────────────────────────

/** Settings the apps never see: where tickets go is staff business. */
const PRIVATE_SETTINGS = ['queue_id', 'fallback_queue_id', 'legacy_category'];

/**
 * The tree as a family's app receives it: routing settings stripped, and nodes
 * whose campus/segment/class conditions match none of the family's children
 * removed. Child conditions stay, since they depend on what the parent picks.
 */
export function parentView(tree: FlowTree, family: FlowPlacement[]): FlowTree {
  const keep = (node: FlowNode): FlowNode | null => {
    const cond = node.conditions;
    if (
      cond &&
      hasPlacement(cond) &&
      !family.some((p) => placementMatches(cond, p))
    )
      return null;
    const settings = { ...(node.settings ?? {}) };
    for (const k of PRIVATE_SETTINGS) delete settings[k];
    const children = (node.children ?? [])
      .map(keep)
      .filter((c): c is FlowNode => c !== null);
    return { ...node, settings, children };
  };
  return {
    schema: tree.schema ?? FLOW_SCHEMA,
    lanes: tree.lanes
      .map(keep)
      .filter(
        (l): l is FlowNode => l !== null && (l.children?.length ?? 0) > 0,
      ),
  };
}

/** Every TICKET leaf with the keys that lead to it. */
export function ticketLeaves(
  tree: FlowTree,
): Array<{ leaf: FlowNode; lane: FlowNode; path: string[]; labels: string[] }> {
  const out: Array<{
    leaf: FlowNode;
    lane: FlowNode;
    path: string[];
    labels: string[];
  }> = [];
  const idx = indexTree(tree);
  for (const x of idx.values()) {
    if (x.node.type !== 'TICKET') continue;
    out.push({
      leaf: x.node,
      lane: x.lane,
      path: x.path,
      labels: x.path.map((k) => idx.get(k)!.node.label),
    });
  }
  return out;
}

/**
 * The leaf an old-app ticket (category + subtopic text) corresponds to, so it
 * still gets a lane and a leaf. Prefers the leaf whose child condition fits.
 */
export function findLeafBySubtopic(
  tree: FlowTree,
  category: 'GENERAL' | 'FINANCIAL',
  subtopic: string,
  aboutChild: boolean,
): { lane: FlowNode; leaf: FlowNode; path: string[] } | null {
  const wanted = subtopic.trim().toLowerCase();
  const candidates = [...indexTree(tree).values()].filter(
    (x) =>
      x.node.type === 'TICKET' &&
      laneSettings(x.lane).legacy_category === category &&
      x.node.label.trim().toLowerCase().slice(0, 100) === wanted,
  );
  const fit = candidates.find(
    (x) =>
      (x.node.conditions?.child ?? (aboutChild ? 'WITH' : 'WITHOUT')) ===
      (aboutChild ? 'WITH' : 'WITHOUT'),
  );
  const hit = fit ?? candidates[0];
  return hit ? { lane: hit.lane, leaf: hit.node, path: hit.path } : null;
}

export interface FlowDiff {
  added: string[];
  removed: string[];
  renamed: string[];
  moved: string[];
  changed: string[];
}

/** What publishing `next` over `prev` changes, by step key. */
export function diffTrees(prev: FlowTree | null, next: FlowTree): FlowDiff {
  const a = prev ? indexTree(prev) : new Map<string, IndexedNode>();
  const b = indexTree(next);
  const diff: FlowDiff = {
    added: [],
    removed: [],
    renamed: [],
    moved: [],
    changed: [],
  };
  for (const [key, x] of b) {
    const old = a.get(key);
    if (!old) {
      diff.added.push(x.node.label);
      continue;
    }
    if (old.node.label !== x.node.label)
      diff.renamed.push(`${old.node.label} → ${x.node.label}`);
    if ((old.parent?.key ?? null) !== (x.parent?.key ?? null))
      diff.moved.push(x.node.label);
    const strip = (n: FlowNode) =>
      JSON.stringify({ ...n, children: undefined, label: undefined });
    if (strip(old.node) !== strip(x.node)) diff.changed.push(x.node.label);
  }
  for (const [key, x] of a) if (!b.has(key)) diff.removed.push(x.node.label);
  return diff;
}

// ─── Version 1: today's wizard, node for node ────────────────────────────────

function slug(prefix: string, text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${prefix}${s}`.slice(0, 40).replace(/-+$/g, '');
}

function topicLeaf(
  prefix: string,
  topic: string,
  child?: 'WITH' | 'WITHOUT',
): FlowNode {
  return {
    key: slug(prefix, topic),
    type: 'TICKET',
    label: topic,
    ...(child ? { conditions: { child } } : {}),
    settings: { min_length: DEFAULT_MIN_LENGTH, attachments: true },
  };
}

/**
 * The first published flow: exactly the questions the hard-coded wizard asks
 * today. Leaf labels equal the old subtopic strings, so every existing routing
 * rule matches a v1 ticket exactly as it matches an old-app ticket.
 */
export function defaultTree(): FlowTree {
  const o = ORIGINATION_OPTIONS;
  return {
    schema: FLOW_SCHEMA,
    lanes: [
      {
        key: 'general',
        type: 'LANE',
        label: 'General',
        help: 'Academics, behaviour, attendance and school matters',
        icon: 'school',
        settings: {
          color: '#2563EB',
          legacy_category: 'GENERAL',
          description: 'Academics, behaviour, attendance and school matters',
        },
        children: [
          {
            key: 'general-child',
            type: 'PICK_CHILD',
            label: 'Which child is this about?',
            settings: {
              prompt: 'Which child is this about?',
              allow_none: true,
              none_label: o.childOptions.GENERAL_NO_CHILD_LABEL,
              then_prompt: 'What is this about?',
            },
            children: [
              ...o.topics.GENERAL_WITH_CHILD.map((t) =>
                topicLeaf('gc-', t, 'WITH'),
              ),
              ...o.topics.GENERAL_NO_CHILD.map((t) =>
                topicLeaf('gn-', t, 'WITHOUT'),
              ),
            ],
          },
        ],
      },
      {
        key: 'fees',
        type: 'LANE',
        label: 'Fees & Payments',
        help: 'Vouchers, payments, refunds and discounts',
        icon: 'payments',
        settings: {
          color: '#16A34A',
          legacy_category: 'FINANCIAL',
          description: 'Vouchers, payments, refunds and discounts',
        },
        children: [
          {
            key: 'fees-child',
            type: 'PICK_CHILD',
            label: 'Which child is this about?',
            settings: {
              prompt: 'Which child is this about?',
              allow_none: true,
              none_label: o.childOptions.FINANCIAL_FAMILY_LABEL,
              then_prompt: 'What is this about?',
            },
            children: o.topics.FINANCIAL.map((t) => topicLeaf('f-', t)),
          },
        ],
      },
    ],
  };
}
