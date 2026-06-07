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
