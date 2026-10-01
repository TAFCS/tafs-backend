import { StaffRole, TicketCategory, TicketChildMatch } from '@prisma/client';

/** What a new ticket is about, as far as routing rules can see. */
export interface RoutingSubject {
  category: TicketCategory;
  subtopic?: string | null;
  /** Absent for family-level tickets that are not about one child. */
  student?: {
    campus_id: number | null;
    class_id: number | null;
    segment_id: number | null;
  } | null;
}

export interface RoutingRuleShape {
  id: number;
  category: TicketCategory;
  child_match: TicketChildMatch;
  campus_id: number | null;
  segment_id: number | null;
  class_ids: number[];
  subtopic: string | null;
  priority: number;
  is_active: boolean;
}

/** True when every condition the rule sets holds for the subject. */
export function ruleMatches(rule: RoutingRuleShape, subject: RoutingSubject): boolean {
  if (!rule.is_active || rule.category !== subject.category) return false;
  const student = subject.student ?? null;
  if (rule.child_match === TicketChildMatch.WITH_CHILD && !student) return false;
  if (rule.child_match === TicketChildMatch.NO_CHILD && student) return false;
  if (rule.subtopic && rule.subtopic.trim().toLowerCase() !== (subject.subtopic ?? '').trim().toLowerCase()) {
    return false;
  }
  // Placement conditions can only match a ticket about a specific child.
  if (rule.campus_id != null && rule.campus_id !== student?.campus_id) return false;
  if (rule.segment_id != null && rule.segment_id !== student?.segment_id) return false;
  if (rule.class_ids.length > 0 && !rule.class_ids.includes(student?.class_id ?? -1)) return false;
  return true;
}

/**
 * How narrowly a rule is drawn. Subtopic outranks placement because it names
 * the kind of problem ("Transport"), which is a stronger signal than where the
 * child sits; among placements class > segment > campus.
 */
export function ruleSpecificity(rule: RoutingRuleShape): number {
  return (
    (rule.subtopic ? 16 : 0) +
    (rule.class_ids.length > 0 ? 8 : 0) +
    (rule.segment_id != null ? 4 : 0) +
    (rule.campus_id != null ? 2 : 0) +
    (rule.child_match !== TicketChildMatch.ANY ? 1 : 0)
  );
}

/** Matching rules in the order routing tries them: most specific, then priority, then oldest. */
export function orderMatchingRules<T extends RoutingRuleShape>(
  rules: T[],
  subject: RoutingSubject,
): T[] {
  return rules
    .filter((r) => ruleMatches(r, subject))
    .sort(
      (a, b) =>
        ruleSpecificity(b) - ruleSpecificity(a) || a.priority - b.priority || a.id - b.id,
    );
}

/**
 * The legacy lane stored in support_tickets.routed_role. Clients and closed-ticket
 * history still read it: fees are the finance lane, a ticket sent to a named person
 * about a child is the principal lane, anything else is the general desk lane.
 */
export function laneFor(
  category: TicketCategory,
  target: 'user' | 'queue' | 'none',
): StaffRole {
  if (category === TicketCategory.FINANCIAL) return StaffRole.FINANCE_CLERK;
  return target === 'user' ? StaffRole.PRINCIPAL : StaffRole.GENERAL_RESPONDENT;
}

const RESPONDER_ROLES: StaffRole[] = [
  'PRINCIPAL',
  'FINANCE_CLERK',
  'GENERAL_RESPONDENT',
];

/**
 * Closed-ticket peer visibility: admins see all; responder roles see their lane;
 * anyone sees closed tickets of the queues they belong to.
 */
export function closedTicketVisibilityWhere(
  staff: { role: StaffRole },
  queueIds: number[] = [],
) {
  if (staff.role === 'SUPER_ADMIN' || staff.role === 'CAMPUS_ADMIN') {
    return { status: 'CLOSED' as const };
  }
  const or: Array<Record<string, unknown>> = [];
  if (RESPONDER_ROLES.includes(staff.role)) or.push({ routed_role: staff.role });
  if (queueIds.length > 0) or.push({ routed_queue_id: { in: queueIds } });
  if (or.length === 0) return { status: 'CLOSED' as const, id: '__none__' };
  return { status: 'CLOSED' as const, OR: or };
}

/** Row-level twin of closedTicketVisibilityWhere for a single closed ticket. */
export function canSeeClosedTicket(
  staff: { role: StaffRole },
  ticket: { routed_role: StaffRole; routed_queue_id: number | null },
  queueIds: number[] = [],
): boolean {
  if (staff.role === 'SUPER_ADMIN' || staff.role === 'CAMPUS_ADMIN') return true;
  if (RESPONDER_ROLES.includes(staff.role) && ticket.routed_role === staff.role) return true;
  return ticket.routed_queue_id != null && queueIds.includes(ticket.routed_queue_id);
}

export const ORIGINATION_OPTIONS = {
  categories: [
    {
      value: 'GENERAL',
      label: 'General Inquiry (academics, behavior, attendance, school matters)',
    },
    {
      value: 'FINANCIAL',
      label: 'Fees & Payments',
    },
  ],
  topics: {
    GENERAL_WITH_CHILD: [
      'Academics / Classwork',
      'Behavior / Discipline',
      'Attendance & Leave',
      'Homework / Assignments',
      'Teacher or Classroom Concern',
      'Events / Activities',
      'Other',
    ],
    GENERAL_NO_CHILD: [
      'School Timings / Calendar / Holidays',
      'Transport',
      'Admissions / Enrollment / Transfer',
      'Facilities (canteen, uniform, etc.)',
      'School Policy / Circulars',
      'Not sure who to ask',
      'Other',
    ],
    FINANCIAL: [
      'Fee Voucher / Invoice Question',
      'Payment Not Reflecting / Receipt Issue',
      'Refund Request',
      'Discount / Concession / Scholarship',
      'Late Fee / Surcharge Dispute',
      'Fee Structure / Amount Clarification',
      'Other',
    ],
  },
  childOptions: {
    GENERAL_NO_CHILD_LABEL: 'Something general — not about one specific child',
    FINANCIAL_FAMILY_LABEL: 'About the family account / more than one child',
  },
} as const;
