import { TicketCategory, TicketChildMatch } from '@prisma/client';
import {
  orderMatchingRules,
  type RoutingRuleShape,
  type RoutingSubject,
} from '../../../common/support-ticket-routing';
import {
  defaultTree,
  diffTrees,
  findLeafBySubtopic,
  parentView,
  structureIssues,
  ticketLeaves,
  validateTree,
  walkPath,
  type ValidationContext,
} from './flow-tree';
import type { FlowNode, FlowTree } from './flow.types';

// TAFSD-447: the ticket flow tree.

const ali = { campus_id: 1, class_id: 15, segment_id: 3 };
const sara = { campus_id: 2, class_id: 9, segment_id: 2 };
const family = [ali, sara];
const noQueues: ValidationContext = { queues: new Map() };
const codes = (tree: FlowTree, ctx = noQueues) =>
  validateTree(tree, ctx)
    .filter((i) => i.severity === 'error')
    .map((i) => i.code);

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}

describe('version 1 reproduces the old wizard', () => {
  const tree = defaultTree();

  it('validates with no errors', () => {
    expect(codes(tree)).toEqual([]);
  });

  it('has a leaf for every old topic, in both lanes', () => {
    const leaves = ticketLeaves(tree);
    expect(leaves.filter((l) => l.lane.key === 'general')).toHaveLength(14);
    expect(leaves.filter((l) => l.lane.key === 'fees')).toHaveLength(7);
    expect(new Set(leaves.map((l) => l.leaf.key)).size).toBe(leaves.length);
  });

  /**
   * The golden check: an old-app ticket and the same choice made through the v1
   * flow match the same routing rules in the same order, for every leaf, with and
   * without placement. Leaf labels are the old subtopic strings, and a subtopic
   * rule's weight scales the same for every rule on one ticket.
   */
  it('routes every leaf exactly like the old subtopic text', () => {
    const rules: RoutingRuleShape[] = [];
    let id = 1;
    const topics = ticketLeaves(tree).map((l) => l.leaf.label);
    for (const category of [TicketCategory.GENERAL, TicketCategory.FINANCIAL]) {
      for (const subtopic of [null, ...new Set(topics)]) {
        for (const child_match of Object.values(TicketChildMatch)) {
          for (const placement of [
            {},
            { campus_id: 1 },
            { segment_id: 3 },
            { class_ids: [15] },
            { campus_id: 2, class_ids: [9] },
          ]) {
            if (
              child_match === TicketChildMatch.NO_CHILD &&
              Object.keys(placement).length
            )
              continue;
            rules.push({
              id: id++,
              category,
              child_match,
              campus_id: null,
              segment_id: null,
              class_ids: [],
              subtopic,
              priority: (id * 37) % 200,
              is_active: true,
              ...placement,
            });
          }
        }
      }
    }
    for (const { lane, leaf, path } of ticketLeaves(tree)) {
      const category =
        lane.key === 'fees' ? TicketCategory.FINANCIAL : TicketCategory.GENERAL;
      const students =
        leaf.conditions?.child === 'WITHOUT'
          ? [null]
          : leaf.conditions?.child === 'WITH'
            ? [ali, sara]
            : [null, ali, sara];
      for (const student of students) {
        const legacy: RoutingSubject = {
          category,
          subtopic: leaf.label,
          student,
        };
        const flow: RoutingSubject = { ...legacy, path_keys: path };
        const walked = walkPath(tree, path, student, family);
        expect(walked.ok).toBe(true);
        expect(orderMatchingRules(rules, flow).map((r) => r.id)).toEqual(
          orderMatchingRules(rules, legacy).map((r) => r.id),
        );
      }
    }
  });

  it('maps old-app subtopics back to their leaf, minding the child', () => {
    expect(findLeafBySubtopic(tree, 'GENERAL', 'Other', true)?.leaf.key).toBe(
      'gc-other',
    );
    expect(findLeafBySubtopic(tree, 'GENERAL', 'Other', false)?.leaf.key).toBe(
      'gn-other',
    );
    expect(
      findLeafBySubtopic(tree, 'FINANCIAL', 'Refund Request', false)?.path,
    ).toEqual(['fees', 'fees-child', 'f-refund-request']);
    expect(
      findLeafBySubtopic(tree, 'GENERAL', 'Refund Request', false),
    ).toBeNull();
  });
});

describe('walkPath', () => {
  const tree = defaultTree();

  it('accepts a child path and a no-child path', () => {
    const a = walkPath(
      tree,
      ['general', 'general-child', 'gc-academics-classwork'],
      ali,
      family,
    );
    expect(a.ok && a.steps.map((s) => s.label)).toEqual([
      'General',
      'Which child is this about?',
      'Academics / Classwork',
    ]);
    expect(
      walkPath(tree, ['general', 'general-child', 'gn-transport'], null, family)
        .ok,
    ).toBe(true);
  });

  it('refuses a leaf that does not fit the child choice', () => {
    const r = walkPath(
      tree,
      ['general', 'general-child', 'gn-transport'],
      ali,
      family,
    );
    expect(r).toMatchObject({ ok: false, code: 'PATH_CHANGED' });
    expect(
      walkPath(
        tree,
        ['general', 'general-child', 'gc-academics-classwork'],
        null,
        family,
      ),
    ).toMatchObject({ ok: false });
  });

  it('refuses unknown keys, branches, and a child without a pick step', () => {
    expect(walkPath(tree, ['general', 'nope'], null, family)).toMatchObject({
      ok: false,
      code: 'PATH_CHANGED',
    });
    expect(
      walkPath(tree, ['general', 'general-child'], null, family),
    ).toMatchObject({ ok: false, code: 'NOT_A_TICKET' });
    const t = clone(tree);
    t.lanes.push({
      key: 'it',
      type: 'LANE',
      label: 'App help',
      settings: { color: '#2563EB', legacy_category: 'GENERAL' },
      children: [{ key: 'it-login', type: 'TICKET', label: 'Cannot log in' }],
    });
    expect(walkPath(t, ['it', 'it-login'], null, family).ok).toBe(true);
    expect(walkPath(t, ['it', 'it-login'], ali, family)).toMatchObject({
      ok: false,
      code: 'BAD_PATH',
    });
  });

  it('requires a child when the pick step does not allow none', () => {
    const t = clone(tree);
    (t.lanes[1].children![0].settings as any).allow_none = false;
    expect(
      walkPath(t, ['fees', 'fees-child', 'f-refund-request'], null, family),
    ).toMatchObject({ ok: false, code: 'CHILD_REQUIRED' });
  });

  it('honours campus conditions against the picked child, or any child before a pick', () => {
    const t = clone(tree);
    const bus: FlowNode = {
      key: 'bus',
      type: 'LANE',
      label: 'Transport',
      conditions: { campus_ids: [2] },
      settings: { color: '#EA580C', legacy_category: 'GENERAL' },
      children: [
        {
          key: 'bus-pick',
          type: 'PICK_CHILD',
          label: 'Which child?',
          settings: { allow_none: false },
          children: [
            {
              key: 'bus-late',
              type: 'TICKET',
              label: 'Bus late',
              conditions: { campus_ids: [2] },
            },
          ],
        },
      ],
    };
    t.lanes.push(bus);
    expect(walkPath(t, ['bus', 'bus-pick', 'bus-late'], sara, family).ok).toBe(
      true,
    );
    expect(
      walkPath(t, ['bus', 'bus-pick', 'bus-late'], ali, family),
    ).toMatchObject({ ok: false, code: 'PATH_CHANGED' });
    expect(
      walkPath(t, ['bus', 'bus-pick', 'bus-late'], ali, [ali]),
    ).toMatchObject({ ok: false, code: 'PATH_CHANGED' });
  });
});

describe('parentView', () => {
  it('strips routing settings and drops nodes no child can see', () => {
    const t = defaultTree();
    (t.lanes[0].settings as any).fallback_queue_id = 9;
    (t.lanes[0].children![0].children![0].settings as any).queue_id = 4;
    t.lanes.push({
      key: 'hostel',
      type: 'LANE',
      label: 'Hostel',
      conditions: { campus_ids: [7] },
      settings: { color: '#9333EA', legacy_category: 'GENERAL' },
      children: [{ key: 'h1', type: 'TICKET', label: 'Room' }],
    });
    const v = parentView(t, family);
    expect(v.lanes.map((l) => l.key)).toEqual(['general', 'fees']);
    expect(v.lanes[0].settings).not.toHaveProperty('fallback_queue_id');
    expect(v.lanes[0].settings).not.toHaveProperty('legacy_category');
    expect(v.lanes[0].children![0].children![0].settings).not.toHaveProperty(
      'queue_id',
    );
    expect(v.lanes[0].children![0].children![0].conditions).toEqual({
      child: 'WITH',
    });
  });
});

describe('validateTree', () => {
  const queues: ValidationContext = {
    queues: new Map([
      [
        1,
        {
          name: 'Front desk',
          category: 'GENERAL',
          is_active: true,
          is_fallback: true,
        },
      ],
      [
        2,
        {
          name: 'Accounts',
          category: 'FINANCIAL',
          is_active: true,
          is_fallback: true,
        },
      ],
      [
        3,
        {
          name: 'Old',
          category: 'GENERAL',
          is_active: false,
          is_fallback: false,
        },
      ],
    ]),
  };

  it('rejects malformed trees at save time', () => {
    expect(structureIssues({}).map((i) => i.code)).toEqual(['BAD_TREE']);
    const t = defaultTree();
    t.lanes[1].children![0].children![0].key = 'gc-other';
    t.lanes[0].children![0].type = 'WIZARD' as any;
    t.lanes.push({ key: 'Bad Key', type: 'TICKET', label: '' });
    const c = structureIssues(t).map((i) => i.code);
    expect(c).toEqual(
      expect.arrayContaining([
        'DUPLICATE_KEY',
        'UNKNOWN_TYPE',
        'BAD_KEY',
        'ROOT_NOT_LANE',
        'NO_LABEL',
      ]),
    );
  });

  it('flags dead ends, wrong-category queues, unknown screens and a second child pick', () => {
    const t = defaultTree();
    t.lanes.push({
      key: 'x',
      type: 'LANE',
      label: 'X',
      settings: { color: '#2563EB', legacy_category: 'GENERAL' },
      children: [
        { key: 'x-q', type: 'QUESTION', label: 'Empty' },
        {
          key: 'x-t',
          type: 'TICKET',
          label: 'Fees by mistake',
          settings: { queue_id: 2 },
        },
        {
          key: 'x-s',
          type: 'SCREEN',
          label: 'Somewhere',
          settings: { screen: 'moon' },
        },
        { key: 'x-i', type: 'INFO', label: 'Read me', settings: {} },
        {
          key: 'x-c',
          type: 'TICKET',
          label: 'Child only',
          conditions: { child: 'WITH' },
        },
      ],
    });
    t.lanes[0].children![0].children![0].type = 'PICK_CHILD';
    t.lanes[0].children![0].children![0].settings = {
      allow_none: false,
    };
    t.lanes[0].children![0].children![0].children = [
      { key: 'deep', type: 'TICKET', label: 'Deep' },
    ];
    expect(codes(t, queues)).toEqual(
      expect.arrayContaining([
        'EMPTY_BRANCH',
        'QUEUE_CATEGORY',
        'UNKNOWN_SCREEN',
        'INFO_NO_BODY',
        'CHILD_CONDITION_WITHOUT_PICK',
        'PICK_TWICE',
      ]),
    );
  });

  it('warns about switched-off queues, and not about leaves left to the rules', () => {
    const t = defaultTree();
    (t.lanes[0].children![0].children![0].settings as any).queue_id = 3;
    const issues = validateTree(t, queues);
    expect(issues.find((i) => i.code === 'QUEUE_INACTIVE')?.severity).toBe(
      'warning',
    );
    expect(issues.filter((i) => i.severity === 'warning')).toHaveLength(1);
  });
});

describe('diffTrees', () => {
  it('names added, removed, renamed and moved steps', () => {
    const a = defaultTree();
    const b = clone(a);
    const kids = b.lanes[0].children![0].children!;
    kids[0].label = 'Academics';
    const moved = kids.splice(1, 1)[0];
    b.lanes[1].children![0].children!.push(moved);
    b.lanes[1].children![0].children!.splice(0, 1);
    b.lanes.push({
      key: 'it',
      type: 'LANE',
      label: 'App help',
      settings: { color: '#2563EB', legacy_category: 'GENERAL' },
      children: [],
    });
    const d = diffTrees(a, b);
    expect(d.renamed).toEqual(['Academics / Classwork → Academics']);
    expect(d.moved).toEqual(['Behavior / Discipline']);
    expect(d.removed).toEqual(['Fee Voucher / Invoice Question']);
    expect(d.added).toEqual(['App help']);
  });
});

describe('node rules', () => {
  const base = {
    category: TicketCategory.GENERAL,
    child_match: TicketChildMatch.ANY,
    campus_id: null,
    segment_id: null,
    class_ids: [],
    subtopic: null,
    priority: 100,
    is_active: true,
  };
  const subject: RoutingSubject = {
    category: TicketCategory.GENERAL,
    subtopic: 'Bus late',
    student: ali,
    path_keys: ['transport', 'pick', 'bus', 'bus-late'],
  };

  it('match anything under their step, deeper steps first, ahead of placement-only rules', () => {
    const rules: RoutingRuleShape[] = [
      { ...base, id: 1, campus_id: 1, class_ids: [15] },
      { ...base, id: 2, node_key: 'transport' },
      { ...base, id: 3, node_key: 'bus' },
      { ...base, id: 4, node_key: 'elsewhere' },
      { ...base, id: 5, node_key: 'transport', campus_id: 1 },
    ];
    expect(orderMatchingRules(rules, subject).map((r) => r.id)).toEqual([
      3, 5, 2, 1,
    ]);
  });
});
