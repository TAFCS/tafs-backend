import { StaffRole } from '@prisma/client';

/** Principal lookup — campus-wide principals (empty allowed_class_ids) win over class-band matches. */
export function principalLookupWhere(campusId: number, classId: number) {
  return {
    role: 'PRINCIPAL' as const,
    is_active: true,
    deleted_at: null,
    OR: [
      { campus_id: campusId, allowed_class_ids: { equals: [] } },
      { campus_id: campusId, allowed_class_ids: { has: classId } },
    ],
  };
}

/** Sort principals: campus-wide (empty allowed_class_ids) first. */
export function pickPrincipal<
  T extends { allowed_class_ids: number[] },
>(candidates: T[]): T | undefined {
  if (candidates.length === 0) return undefined;
  return [...candidates].sort(
    (a, b) => a.allowed_class_ids.length - b.allowed_class_ids.length,
  )[0];
}

/** app_config key holding the child-ticket routing overrides (JSON array). */
export const ROUTING_OVERRIDES_CONFIG_KEY = 'support_tickets.routing_overrides';

/** Sends child tickets for a campus (optionally only some classes) to a fixed staff member. */
export interface RoutingOverride {
  campus_id: number;
  /** Empty or missing = every class on the campus. */
  class_ids?: number[];
  user_id: string;
}

/** Parses the overrides config; a malformed value yields no overrides. */
export function parseRoutingOverrides(raw: string | null | undefined): RoutingOverride[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (o): o is RoutingOverride =>
        !!o &&
        typeof o.campus_id === 'number' &&
        typeof o.user_id === 'string' &&
        (o.class_ids === undefined ||
          (Array.isArray(o.class_ids) && o.class_ids.every((c: unknown) => typeof c === 'number'))),
    );
  } catch {
    return [];
  }
}

/** Overrides matching a campus/class, class-specific ones before campus-wide ones. */
export function matchRoutingOverrides(
  overrides: RoutingOverride[],
  campusId: number,
  classId: number,
): RoutingOverride[] {
  return overrides
    .filter(
      (o) =>
        o.campus_id === campusId &&
        (!o.class_ids?.length || o.class_ids.includes(classId)),
    )
    .sort((a, b) => (b.class_ids?.length ? 1 : 0) - (a.class_ids?.length ? 1 : 0));
}

const RESPONDER_ROLES: StaffRole[] = [
  'PRINCIPAL',
  'FINANCE_CLERK',
  'GENERAL_RESPONDENT',
];

/** Closed-ticket peer visibility keyed on original routed_role. */
export function closedTicketVisibilityWhere(staff: { role: StaffRole }) {
  if (staff.role === 'SUPER_ADMIN' || staff.role === 'CAMPUS_ADMIN') {
    return { status: 'CLOSED' as const };
  }
  if (RESPONDER_ROLES.includes(staff.role)) {
    return { status: 'CLOSED' as const, routed_role: staff.role };
  }
  return { status: 'CLOSED' as const, id: '__none__' };
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
