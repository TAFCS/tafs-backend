/** Stable category codes (match staff_categories.code seed values). */
export type StaffCategoryCode =
  | 'TEACHER'
  | 'ASSISTANT_TEACHER'
  | 'SPORTS_COACH'
  | 'SCOUT_LEADER'
  | 'ACADEMIC_COORDINATOR'
  | 'ACADEMIC_ADMINISTRATOR'
  | 'SENIOR_LEADERSHIP'
  | 'ADMINISTRATIVE_STAFF'
  | 'IT_STAFF'
  | 'CREATIVE_STAFF'
  | 'FINANCE_STAFF'
  | 'SUPPORT_STAFF';

export const DEPARTMENT_SEED = [
  { name: 'ACADEMICS', description: 'Teachers + academic admin/coordinators + campus principals/headmistresses' },
  { name: 'SENIOR MANAGEMENT', description: 'CEO, MD, group Directresses, Deputy Directress' },
  { name: 'FINANCE', description: 'Directress Finance, Accounts/VAN Coordinator' },
  { name: 'IT & TECHNOLOGY', description: 'IT Manager, Computer Operators, Graphic Designers' },
  { name: 'ADMINISTRATION', description: 'Office Assistants, FDOs, Admin Assistants, Outdoor Rider' },
  { name: 'SUPPORT SERVICES', description: 'Facility and domestic staff' },
] as const;

export type DepartmentName = (typeof DEPARTMENT_SEED)[number]['name'];

export interface StaffOrgResult {
  role: string | null;
  staffCategory: StaffCategoryCode | null;
  departmentName: DepartmentName | null;
}

/** Normalize raw CSV text for lookup (uppercase, collapse whitespace). */
function norm(value: string | null | undefined): string {
  return (value ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
}

/** Explicit dirty job-title → clean role mappings from message.txt (ALL CAPS). */
const JOB_TITLE_ROLE_MAP: Record<string, string> = {
  'URDU SR.II A, C & SR. III': 'URDU TEACHER',
  "SENIOR'S URDU TEACHER SR. I & SR. II B": 'URDU TEACHER',
  'HIS & GEO SR. I ISLAMIYAT SR. I, II': 'HISTORY, GEOGRAPHY & ISLAMIYAT TEACHER',
  'HIS / GEO SR. II - III': 'HISTORY & GEOGRAPHY TEACHER',
  'ENG V-II X ISL VII,VIII': 'ENGLISH & ISLAMIYAT TEACHER',
  'ART TEACHER JR.I - II /': 'ART TEACHER',
  'ART TEACHER JR. I - V': 'ART TEACHER',
  'SCIENCE TEACHER JR.III': 'SCIENCE TEACHER',
  'SCIENCE, S.S.T P.ST': 'SCIENCE & SOCIAL STUDIES TEACHER',
  'URDU TEACHER JR.I': 'URDU TEACHER',
  MATHS: 'MATHEMATICS TEACHER',
  'MATHS TEACHER': 'MATHEMATICS TEACHER',
  CHEMISTRY: 'CHEMISTRY TEACHER',
  PHYSICS: 'PHYSICS TEACHER',
  TAEKONDOW: 'TAEKWONDO COACH',
  GYMNASTIC: 'GYMNASTICS COACH',
  'HOME TEACHER': 'CLASS TEACHER',
  'CHEM / BIO TEACHER': 'CHEMISTRY & BIOLOGY TEACHER',
  'CO- TEACHER': 'CO-TEACHER',
  'CO-TEACHER': 'CO-TEACHER',
  'HELPER TEACHER': 'ASSISTANT TEACHER',
  'ENGLISH TEACHER': 'ENGLISH TEACHER',
  'URDU TEACHER': 'URDU TEACHER',
  'COMPUTER TEACHER': 'COMPUTER SCIENCE TEACHER',
  'BIO TEACHER': 'BIOLOGY TEACHER',
  'MUSIC TEACHER': 'MUSIC TEACHER',
  'SPORTS TEACHER': 'SPORTS TEACHER',
  'SCOUT LEADER': 'SCOUT LEADER',
  'OFFICE ASSISTANT': 'OFFICE ASSISTANT',
  'SINDHI & URDU': 'URDU & SINDHI TEACHER',
};

/** Designation-only rows → role (ALL CAPS). */
const DESIGNATION_ROLE_MAP: Record<string, string> = {
  'C.E.O': 'CHIEF EXECUTIVE OFFICER',
  'MANAGING DIRECTOR': 'MANAGING DIRECTOR',
  'DIRECTRESS FINANCE': 'DIRECTRESS FINANCE',
  'DIRECTRESS ADMIN & P. - G.': 'DIRECTRESS ADMIN & P-G',
  'DIRECTRESS': 'DIRECTRESS',
  'DEPUTY DIRECTRESS I.T, ADMIN & P-G': 'DEPUTY DIRECTRESS IT, ADMIN & P-G',
  "DEPUTY SEGMENT HEAD SENIOR'S": 'DEPUTY SEGMENT HEAD',
  "ACADEMIC CO-ORDINATOR SENIOR'S": 'ACADEMIC COORDINATOR',
  "ACADEMIC ASSISTANT SENIOR'S": 'ACADEMIC ASSISTANT',
  'ACADEMIC ASSISTANTJRI & II': 'ACADEMIC ASSISTANT',
  'ACADEMIC CORDINATOR JR- III - V': 'ACADEMIC COORDINATOR',
  'HEADMISTRESS SECONDARY': 'HEADMISTRESS',
  'ADMINISTRATOR SECONDARY': 'ADMINISTRATOR',
  'COORDINATOR SECONDARY': 'ACADEMIC COORDINATOR',
  'ADMINISTRATIVE ASSISTANT PRE-PRIMARY': 'ADMINISTRATIVE ASSISTANT',
  'AADMINISTRATIVE ASSISTANT JR III- V': 'ADMINISTRATIVE ASSISTANT',
  'MANAGER SPORTS': 'SPORTS MANAGER',
  'MANAGER A LEVEL': 'A-LEVEL MANAGER',
  'MANAGER OF IT & MAINTENANCE COMPLIANCE': 'IT MANAGER',
  'GRAPHIC DESIGNER': 'GRAPHIC DESIGNER',
  'VAN CO-ORDINATOR / ACCOUNTS ASSISTANT': 'ACCOUNTS ASSISTANT & VAN COORDINATOR',
  'COMPUTER OPERATOR': 'COMPUTER OPERATOR',
  'OUT DOOR RIDER': 'OUTDOOR RIDER',
  'F.D.O / OFFICE ASSISTANT': 'FRONT DESK OFFICER',
  'OFFICE ASSISTANT & COMPUTER OPERATOR': 'OFFICE ASSISTANT & COMPUTER OPERATOR',
  'ADMIN. ASST': 'ADMINISTRATIVE ASSISTANT',
  'SUBJECT HEAD & CO-ORDINATOR': 'SUBJECT HEAD & COORDINATOR',
  PRINCIPAL: 'PRINCIPAL',
};

function resolveRole(jobTitle: string | null, designation: string | null): string | null {
  const title = norm(jobTitle);
  const des = norm(designation);

  if (title && JOB_TITLE_ROLE_MAP[title]) return JOB_TITLE_ROLE_MAP[title];
  if (des && DESIGNATION_ROLE_MAP[des]) return DESIGNATION_ROLE_MAP[des];

  if (title) {
    if (/TEACHER$/i.test(title) || /INSTRUCTOR$/i.test(title)) return title;
    if (/^CO-?\s*TEACHER$/i.test(title)) return 'CO-TEACHER';
    if (/^HELPER TEACHER$/i.test(title)) return 'ASSISTANT TEACHER';
    if (/^SCOUT LEADER$/i.test(title)) return 'SCOUT LEADER';
    if (/^OFFICE ASSISTANT$/i.test(title)) return 'OFFICE ASSISTANT';
    return title;
  }

  if (des) {
    if (/COORDINATOR|CO-ORDINATOR/i.test(des)) return 'ACADEMIC COORDINATOR';
    if (/HEADMISTRESS/i.test(des)) return 'HEADMISTRESS';
    if (/PRINCIPAL/i.test(des)) return 'PRINCIPAL';
    if (/DIRECTRESS/i.test(des)) return des.includes('FINANCE') ? 'DIRECTRESS FINANCE' : 'DIRECTRESS';
    if (/GRAPHIC DESIGNER/i.test(des)) return 'GRAPHIC DESIGNER';
    if (/COMPUTER OPERATOR/i.test(des)) return 'COMPUTER OPERATOR';
    if (/F\.D\.O|OFFICE ASSISTANT/i.test(des)) return 'OFFICE ASSISTANT';
    if (/RIDER/i.test(des)) return 'OUTDOOR RIDER';
    if (/MANAGER/i.test(des)) return des.replace(/\s+/g, ' ');
    if (/ASSISTANT|ASST/i.test(des)) return 'ADMINISTRATIVE ASSISTANT';
    if (/C\.E\.O/i.test(des)) return 'CHIEF EXECUTIVE OFFICER';
    if (/MANAGING DIRECTOR/i.test(des)) return 'MANAGING DIRECTOR';
    return des;
  }

  return null;
}

function resolveCategory(role: string | null, designation: string | null): StaffCategoryCode | null {
  const r = norm(role);
  const des = norm(designation);
  const combined = `${r} ${des}`.trim();

  if (/^CO-?TEACHER$|^ASSISTANT TEACHER$|^HELPER TEACHER$/i.test(r)) return 'ASSISTANT_TEACHER';
  if (/TAEKWONDO COACH|GYMNASTICS COACH/i.test(combined)) return 'SPORTS_COACH';
  if (/SCOUT LEADER/i.test(combined)) return 'SCOUT_LEADER';

  if (/CHIEF EXECUTIVE OFFICER|MANAGING DIRECTOR|DEPUTY DIRECTRESS/i.test(combined)) {
    return 'SENIOR_LEADERSHIP';
  }
  if (/DIRECTRESS ADMIN|DIRECTRESS ADMIN & P-G/i.test(combined)) return 'SENIOR_LEADERSHIP';
  if (/DIRECTRESS FINANCE|ACCOUNTS ASSISTANT|VAN CO-ORDINATOR|VAN COORDINATOR/i.test(combined)) {
    return 'FINANCE_STAFF';
  }

  if (/GRAPHIC DESIGNER/i.test(combined)) return 'CREATIVE_STAFF';
  if (/IT MANAGER|COMPUTER OPERATOR/i.test(combined)) return 'IT_STAFF';
  if (/COMPUTER SCIENCE TEACHER/i.test(r)) return 'TEACHER';

  if (/HEADMISTRESS|^PRINCIPAL$|^ADMINISTRATOR$|SPORTS MANAGER|A-LEVEL MANAGER|^DIRECTRESS$/i.test(r)) {
    return 'ACADEMIC_ADMINISTRATOR';
  }
  if (/COORDINATOR|SUBJECT HEAD|ACADEMIC ASSISTANT|DEPUTY SEGMENT HEAD/i.test(combined)) {
    return 'ACADEMIC_COORDINATOR';
  }

  if (/OFFICE ASSISTANT|F\.D\.O|FRONT DESK|ADMINISTRATIVE ASSISTANT|ADMIN\. ASST|OUTDOOR RIDER|OUT DOOR RIDER/i.test(combined)) {
    return 'ADMINISTRATIVE_STAFF';
  }

  if (/TEACHER|CLASS TEACHER|MUSIC TEACHER|ART TEACHER|SPORTS TEACHER|COACH/i.test(combined)) {
    if (/TAEKWONDO|GYMNASTICS/i.test(combined)) return 'SPORTS_COACH';
    return 'TEACHER';
  }

  return null;
}

function resolveDepartment(category: StaffCategoryCode | null, role: string | null): DepartmentName | null {
  if (!category && !role) return null;
  const r = norm(role);

  switch (category) {
    case 'SENIOR_LEADERSHIP':
      return 'SENIOR MANAGEMENT';
    case 'FINANCE_STAFF':
      return 'FINANCE';
    case 'CREATIVE_STAFF':
      return 'IT & TECHNOLOGY';
    case 'IT_STAFF':
      return 'IT & TECHNOLOGY';
    case 'ADMINISTRATIVE_STAFF':
      return 'ADMINISTRATION';
    case 'ACADEMIC_COORDINATOR':
    case 'ACADEMIC_ADMINISTRATOR':
    case 'TEACHER':
    case 'ASSISTANT_TEACHER':
    case 'SPORTS_COACH':
    case 'SCOUT_LEADER':
      return 'ACADEMICS';
    default:
      break;
  }

  if (/CHIEF EXECUTIVE OFFICER|MANAGING DIRECTOR|DEPUTY DIRECTRESS|DIRECTRESS ADMIN/i.test(r)) {
    return 'SENIOR MANAGEMENT';
  }
  if (/DIRECTRESS FINANCE|ACCOUNTS ASSISTANT|VAN CO/i.test(r)) return 'FINANCE';
  if (/GRAPHIC DESIGNER|IT MANAGER|COMPUTER OPERATOR/i.test(r)) return 'IT & TECHNOLOGY';
  if (/OFFICE ASSISTANT|F\.D\.O|RIDER|ADMINISTRATIVE ASSISTANT/i.test(r)) return 'ADMINISTRATION';
  if (r) return 'ACADEMICS';

  return null;
}

/** Per-employee org overrides from staff_mapping_review.txt. */
const EMPLOYEE_ORG_OVERRIDES: Record<string, StaffOrgResult> = {
  // Group-level directress (Johar C-IV) — distinct from campus directress 01-00018.
  '01-00017': {
    role: 'DIRECTRESS',
    staffCategory: 'SENIOR_LEADERSHIP',
    departmentName: 'SENIOR MANAGEMENT',
  },
};

export function resolveStaffOrg(
  jobTitle: string | null,
  designation: string | null,
  employeeCode?: string | null,
): StaffOrgResult {
  const code = employeeCode?.trim().toUpperCase();
  if (code && EMPLOYEE_ORG_OVERRIDES[code]) {
    return EMPLOYEE_ORG_OVERRIDES[code];
  }

  const role = resolveRole(jobTitle, designation);
  const staffCategory = resolveCategory(role, designation);
  const departmentName = resolveDepartment(staffCategory, role);

  return { role, staffCategory, departmentName };
}
