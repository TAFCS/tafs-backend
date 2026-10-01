import {
  canSeeClosedTicket,
  closedTicketVisibilityWhere,
  laneFor,
  orderMatchingRules,
  ruleMatches,
  type RoutingRuleShape,
} from './support-ticket-routing';

describe('support-ticket-routing', () => {
  describe('closedTicketVisibilityWhere', () => {
    it('campus admin sees all closed tickets', () => {
      expect(closedTicketVisibilityWhere({ role: 'CAMPUS_ADMIN' })).toEqual({
        status: 'CLOSED',
      });
    });

    it('principal sees closed tickets routed to principals', () => {
      expect(closedTicketVisibilityWhere({ role: 'PRINCIPAL' })).toEqual({
        status: 'CLOSED',
        OR: [{ routed_role: 'PRINCIPAL' }],
      });
    });

    it('queue members see closed tickets of their queues', () => {
      expect(closedTicketVisibilityWhere({ role: 'TEACHER' }, [3])).toEqual({
        status: 'CLOSED',
        OR: [{ routed_queue_id: { in: [3] } }],
      });
      expect(
        canSeeClosedTicket({ role: 'TEACHER' }, { routed_role: 'GENERAL_RESPONDENT', routed_queue_id: 3 }, [3]),
      ).toBe(true);
      expect(
        canSeeClosedTicket({ role: 'TEACHER' }, { routed_role: 'GENERAL_RESPONDENT', routed_queue_id: 4 }, [3]),
      ).toBe(false);
    });

    it('teacher has no closed ticket access', () => {
      expect(closedTicketVisibilityWhere({ role: 'TEACHER' })).toEqual({
        status: 'CLOSED',
        id: '__none__',
      });
    });
  });

  describe('rule matching', () => {
    const rule = (over: Partial<RoutingRuleShape>): RoutingRuleShape => ({
      id: 1,
      category: 'GENERAL',
      child_match: 'ANY',
      campus_id: null,
      segment_id: null,
      class_ids: [],
      subtopic: null,
      priority: 100,
      is_active: true,
      ...over,
    });
    const child = (campus_id: number, class_id: number, segment_id = 6) => ({
      category: 'GENERAL' as const,
      student: { campus_id, class_id, segment_id },
    });

    it('respects category, child presence and active flag', () => {
      expect(ruleMatches(rule({}), { category: 'FINANCIAL' })).toBe(false);
      expect(ruleMatches(rule({ child_match: 'WITH_CHILD' }), { category: 'GENERAL' })).toBe(false);
      expect(ruleMatches(rule({ child_match: 'NO_CHILD' }), child(1, 15))).toBe(false);
      expect(ruleMatches(rule({ is_active: false }), child(1, 15))).toBe(false);
    });

    it('placement conditions never match a ticket without a child', () => {
      expect(ruleMatches(rule({ campus_id: 1 }), { category: 'GENERAL' })).toBe(false);
    });

    it('matches subtopic case-insensitively', () => {
      expect(ruleMatches(rule({ subtopic: 'Transport' }), { category: 'GENERAL', subtopic: ' transport ' })).toBe(true);
      expect(ruleMatches(rule({ subtopic: 'Transport' }), { category: 'GENERAL', subtopic: 'Other' })).toBe(false);
    });

    it('orders most specific first, then priority, then id', () => {
      const ordered = orderMatchingRules(
        [
          rule({ id: 1, campus_id: 1 }),
          rule({ id: 2, campus_id: 1, class_ids: [15, 16] }),
          rule({ id: 3, campus_id: 1, priority: 10 }),
          rule({ id: 4, segment_id: 6 }),
          rule({ id: 5, campus_id: 2 }),
        ],
        child(1, 15),
      );
      expect(ordered.map((r) => r.id)).toEqual([2, 4, 3, 1]);
    });

    it('subtopic outranks placement', () => {
      const ordered = orderMatchingRules(
        [rule({ id: 1, campus_id: 1, class_ids: [15] }), rule({ id: 2, subtopic: 'Transport' })],
        { ...child(1, 15), subtopic: 'Transport' },
      );
      expect(ordered[0].id).toBe(2);
    });

    it('keeps the legacy routed_role lane', () => {
      expect(laneFor('FINANCIAL', 'queue')).toBe('FINANCE_CLERK');
      expect(laneFor('GENERAL', 'user')).toBe('PRINCIPAL');
      expect(laneFor('GENERAL', 'queue')).toBe('GENERAL_RESPONDENT');
    });
  });
});
