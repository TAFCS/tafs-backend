/**
 * A sub-permission inside a tile: "what may they DO once they are in here".
 *
 * Addressed globally as `tileId#actionId`, e.g.
 * `hr.employee_directory#schedule_pay.edit`.
 */
export type TileAction = {
  id: string;
  label: string;
  description?: string;
  /** Conferred automatically when the tile itself is granted. */
  default?: boolean;
  /** Action ids in the same tile that this one also confers, transitively. */
  implies?: string[];
};

export type TileManifestEntry = {
  id: string;
  module: string;
  label: string;
  description: string;
  href: string;
  group?: string;
  capabilities: string[];
  /**
   * Omit entirely and the tile behaves exactly as it did before
   * sub-permissions existed: granting the tile grants the whole tile.
   */
  actions?: TileAction[];
  /**
   * Legacy bridge. Holding any of these capability keys confers EVERY action
   * of this tile.
   *
   * This is what stops sub-permissions from being a breaking change. Before
   * they existed, `hr.employees.edit` in a role baseline meant "can do
   * anything in the employee directory". The day actions ship, that has to
   * keep meaning the same thing, or every existing role silently loses edit
   * access to everything. Narrowing only happens once an admin deliberately
   * sets sub-permissions.
   *
   * Remove a key here only once every role that carries it has been
   * re-expressed as packs and actions.
   */
  legacyFullAccessCapabilities?: string[];
};

/**
 * Sub-permissions for the Employee Directory -- the first tile to get them.
 *
 * One view/edit pair per tab in EmployeeDetailPanel's BASE_TABS, plus the
 * discrete actions that were all collapsed into `Manage Employee` before:
 * ~25 routes on employees.controller.ts resolved to exactly two checks, so
 * editing a phone number and deleting an employee needed the same permission.
 */
/**
 * Sub-permissions for the Student Directory.
 *
 * Unlike the Employee Directory these are not tab-shaped: the student record
 * has no multi-tab write. They follow the routes instead -- reading a student
 * is one thing, seeing their money is another, and moving or promoting them is
 * a third.
 */
const STUDENT_DIRECTORY_ACTIONS: TileAction[] = [
  { id: 'view', label: 'Open directory', description: 'See the student list, search it, and open a record', default: true },

  { id: 'payment_history.view', label: 'View payment history', description: 'What the family has paid', implies: ['view'] },
  { id: 'progression.view', label: 'View academic history', description: 'Progression, academic history and house history', implies: ['view'] },

  { id: 'assignment.edit', label: 'Move a student', description: 'Campus, class, section and house assignment', implies: ['view'] },
  { id: 'status.change', label: 'Change status', description: 'Expel, mark left, return, unexpel, undo left', implies: ['view'] },
  { id: 'promote', label: 'Promote', description: 'Single and bulk promotion, and GR suggestions for it', implies: ['view'] },
  { id: 'export', label: 'Export to Excel', implies: ['view'] },
];

const EMPLOYEE_DIRECTORY_ACTIONS: TileAction[] = [
  { id: 'view', label: 'Open directory', description: 'See the employee list and open a record', default: true },

  { id: 'profile.view', label: 'View profile', implies: ['view'] },
  { id: 'profile.edit', label: 'Edit profile', description: 'Name, CNIC, contact, family, photos, previous employers', implies: ['profile.view'] },

  { id: 'employment.view', label: 'View employment', implies: ['view'] },
  { id: 'employment.edit', label: 'Edit employment', description: 'Department, category, job title, code, dates', implies: ['employment.view'] },

  { id: 'schedule_pay.view', label: 'View schedule & pay', description: 'Includes the salary figure', implies: ['view'] },
  { id: 'schedule_pay.edit', label: 'Edit schedule & pay', description: 'Monthly pay, timings, work schedule, increment cycle', implies: ['schedule_pay.view'] },

  { id: 'security_deposit.view', label: 'View security deposit', implies: ['view'] },
  { id: 'security_deposit.edit', label: 'Edit security deposit', implies: ['security_deposit.view'] },

  { id: 'loan.view', label: 'View loans', implies: ['view'] },
  { id: 'loan.edit', label: 'Edit loans', implies: ['loan.view'] },

  { id: 'classes.view', label: 'View class & sections', implies: ['view'] },
  { id: 'classes.edit', label: 'Edit class & sections', implies: ['classes.view'] },

  { id: 'progression.view', label: 'View progression', implies: ['view'] },
  { id: 'progression.edit', label: 'Edit progression', implies: ['progression.view'] },

  { id: 'portal.view', label: 'View portal account', implies: ['view'] },
  { id: 'portal.edit', label: 'Edit portal account', description: 'Role, campus and account status', implies: ['portal.view'] },
  { id: 'portal.reveal_password', label: 'Reveal portal password', description: 'Audited on every use', implies: ['portal.view'] },
  { id: 'portal.reset_password', label: 'Reset portal password', implies: ['portal.edit'] },
  { id: 'portal.change_username', label: 'Change username', implies: ['portal.edit'] },

  { id: 'biometric.view', label: 'View biometric', implies: ['view'] },
  { id: 'biometric.edit', label: 'Edit biometric', description: 'Device mappings and PIN linkage', implies: ['biometric.view'] },

  { id: 'shift_overrides.view', label: 'View shift overrides', implies: ['view'] },
  { id: 'shift_overrides.edit', label: 'Edit shift overrides', implies: ['shift_overrides.view'] },

  { id: 'create', label: 'Register an employee', implies: ['view'] },
  { id: 'delete', label: 'Delete an employee', implies: ['view'] },
  { id: 'status.change', label: 'Change employment status', description: 'Active, Permanent, Family, Left, Terminated', implies: ['employment.view'] },
  { id: 'export', label: 'Export to Excel', description: 'Directory export and master export', implies: ['view'] },
];

/**
 * Source of truth for ERP tiles. The API catalog and effective-tile math
 * read this array from memory. On boot, AccessSync upserts the same rows
 * into `access_tiles` so pack/grant foreign keys have something to point at.
 * Edit this file (and seed a new capability key if needed) to split a tile
 * without a frontend deploy.
 */
export const TILES_MANIFEST: TileManifestEntry[] = [
  // ?? Student & Profiling ??????????????????????????????????????????????????
  { id: 'student.quick_registration', module: 'student', label: 'Quick Registration', description: 'Unconfirmed admission intake', href: '/identity/quick-registration', capabilities: ['students.registration.view'] },
  { id: 'student.registration', module: 'student', label: 'Registration', description: 'New student intake', href: '/identity/register', capabilities: ['students.registration.view'] },
  { id: 'student.enrollments', module: 'student', label: 'Enrollments', description: 'Class and section assignment', href: '/enrollments', capabilities: ['students.enrollment.view'] },
  { id: 'student.directory', module: 'student', label: 'Student Directory', description: 'Search all students', href: '/identity/students', capabilities: ['students.directory.view'], actions: STUDENT_DIRECTORY_ACTIONS, legacyFullAccessCapabilities: ['students.directory.edit'] },
  { id: 'student.families', module: 'student', label: 'Families', description: 'Guardian and contact info', href: '/families', capabilities: ['students.families.view'] },
  { id: 'student.parent_change_requests', module: 'student', label: 'Parent Change Requests', description: 'Profile update approvals', href: '/parent-change-requests', capabilities: ['students.families.view'] },
  { id: 'student.transfers', module: 'student', label: 'Transfers', description: 'Inter-school movements', href: '/transfers', capabilities: ['academic.transfers.view'] },
  { id: 'student.academic_actions', module: 'student', label: 'Academic Actions', description: 'Bulk promotions and actions', href: '/bulk-promote', capabilities: ['academic.bulk_promote.execute'] },
  { id: 'student.section_allocation', module: 'student', label: 'Section Allocation Rules', description: 'Capacity and gender limits per campus/class/section', href: '/campuses/allocation-rules', capabilities: ['academic.campuses.view'] },
  { id: 'student.house_balancer', module: 'student', label: 'House Balancer', description: 'Random evenly balanced house redistribution', href: '/house-balancer', capabilities: ['academic.campuses.view'] },

  // ?? Finance ??????????????????????????????????????????????????????????????
  { id: 'finance.financial_reports', module: 'finance', label: 'Financial Reports', description: 'Fee heads (accrual), deposits (cash), a student x month fee matrix, and the defaulters list, with filters and exports', href: '/financial-reports', capabilities: ['system.analytics.view'] },
  { id: 'finance.class_fee_schedule', module: 'finance', label: 'Class Fee Schedule', description: 'Per-class fee configuration', href: '/classwise-fees-schedule', capabilities: ['fee_admin.classwise_schedule.view'] },
  { id: 'finance.student_overrides', module: 'finance', label: 'Student Overrides', description: 'Individual fee adjustments', href: '/studentwise-fees', capabilities: ['fee_admin.studentwise_schedule.view'] },
  { id: 'finance.single_voucher', module: 'finance', label: 'Single Voucher Issuance', description: 'Print individual fee slips', href: '/fee-challan', capabilities: ['finance.vouchers.view'] },
  { id: 'finance.bulk_voucher', module: 'finance', label: 'Bulk Voucher Issuance', description: 'Generate multiple vouchers', href: '/bulk-voucher', capabilities: ['finance.vouchers.generate_bulk'] },
  { id: 'finance.vouchers', module: 'finance', label: 'Vouchers', description: 'All issued vouchers', href: '/vouchers', capabilities: ['finance.vouchers.view'] },
  { id: 'finance.pending_release', module: 'finance', label: 'Pending Release', description: 'Held vouchers awaiting parent visibility', href: '/pending-release', capabilities: ['finance.vouchers.release'] },
  { id: 'finance.payment_history', module: 'finance', label: 'Payment History', description: 'Payment transaction log', href: '/payment-history', capabilities: ['finance.vouchers.view'] },
  { id: 'finance.receive_deposit', module: 'finance', label: 'Receive Deposit', description: 'Record cash and cheque deposits', href: '/vouchers/deposit', capabilities: ['finance.deposits.record'] },
  { id: 'finance.postdated_cheques', module: 'finance', label: 'Post-dated Cheques', description: 'Cheque tracking and alerts', href: '/postdated-cheques', capabilities: ['finance.vouchers.view'] },

  // ?? Communications ???????????????????????????????????????????????????????
  { id: 'communication.notice_board', module: 'communication', label: 'Notice Board', description: 'Broadcast announcements', href: '/notice-board', capabilities: ['communication.send_announcements'] },
  { id: 'communication.support_tickets', module: 'communication', label: 'Support Tickets', description: 'Issue tracking and resolution', href: '/support-tickets', capabilities: ['communication.support_tickets.view'] },
  { id: 'communication.notification_templates', module: 'communication', label: 'Notification Templates', description: 'Edit push notification text', href: '/admin/notification-templates', capabilities: ['system.permissions.manage'] },

  // ?? HR & Payroll ?????????????????????????????????????????????????????????
  { id: 'hr.employee_directory', module: 'hr', label: 'Employee Directory', description: 'Staff profiles and records', href: '/hr/employees', capabilities: ['hr.employees.view'], actions: EMPLOYEE_DIRECTORY_ACTIONS, legacyFullAccessCapabilities: ['hr.employees.edit'] },
  { id: 'hr.register_employee', module: 'hr', label: 'Register a Employee', description: 'Create new employee profile', href: '/hr/employees/new', capabilities: ['hr.employees.view'] },
  { id: 'hr.departments', module: 'hr', label: 'Departments', description: 'Departments and staff categories', href: '/hr/departments', capabilities: ['hr.employees.view'] },
  { id: 'hr.payroll', module: 'hr', label: 'Payroll', description: 'Salary processing', href: '/hr/payroll', capabilities: ['hr.payroll.view'] },
  { id: 'hr.payroll_rules', module: 'hr', label: 'Payroll Rules', description: 'EOBI, SESSI & income tax rates', href: '/hr/payroll/rules', capabilities: ['hr.payroll.view'] },
  { id: 'hr.security_deposits', module: 'hr', label: 'Security Deposits', description: 'Caution money plans across employees', href: '/hr/security-deposits', capabilities: ['hr.employees.view'] },
  { id: 'hr.employee_loans', module: 'hr', label: 'Employee Loans', description: 'Salary advance loans across employees', href: '/hr/employee-loans', capabilities: ['hr.employees.view'] },
  { id: 'hr.salary_increments', module: 'hr', label: 'Salary Increments', description: 'Plan, review and apply salary increases in bulk', href: '/hr/salary-increments', capabilities: ['hr.employees.view'] },
  { id: 'hr.employee_notices', module: 'hr', label: 'Employee Notices', description: 'Broadcast announcements to staff by role', href: '/hr/notices', capabilities: ['communication.send_employee_announcements'] },

  // ?? Attendance ???????????????????????????????????????????????????????????
  { id: 'attendance.staff_register', module: 'attendance', label: 'Staff Register', description: 'Daily staff punch-in', href: '/hr/staff-register', group: 'Employees', capabilities: ['attendance.staff.mark'] },
  { id: 'attendance.employee_attendance', module: 'attendance', label: 'Employee Attendance', description: 'Daily staff clock-in/out from biometric devices', href: '/hr/attendance-dashboard', group: 'Employees', capabilities: ['attendance.staff.mark', 'hr.objections.review'] },
  { id: 'attendance.employee_attendance_cycle', module: 'attendance', label: 'Employee Attendance by Cycle', description: 'Employee lines and punch matrix over a date range', href: '/hr/attendance-dashboard/cycle', group: 'Employees', capabilities: ['hr.payroll.view'] },
  { id: 'attendance.objections', module: 'attendance', label: 'Attendance Objections', description: 'Review employee attendance disputes', href: '/hr/objections', group: 'Employees', capabilities: ['hr.objections.review'] },
  { id: 'attendance.leave_requests', module: 'attendance', label: 'Leave Requests', description: 'Review employee leave applications', href: '/hr/leaves', group: 'Employees', capabilities: ['hr.leave.approve'] },
  { id: 'attendance.student_attendance', module: 'attendance', label: 'Student Attendance', description: 'Per-class attendance records', href: '/hr/student-attendance-dashboard', group: 'Students', capabilities: ['attendance.student.rollcall.mark', 'attendance.student.rollcall.view'] },
  { id: 'attendance.student_attendance_cycle', module: 'attendance', label: 'Student Attendance by Cycle', description: 'Student lines and punch matrix over a date range', href: '/hr/student-attendance-dashboard/cycle', group: 'Students', capabilities: ['attendance.student.rollcall.mark', 'attendance.student.rollcall.view'] },
  { id: 'attendance.quick_check_in', module: 'attendance', label: 'Quick Check-In', description: 'Filter, search, and punch students in or out � including default absents', href: '/attendance/quick-check-in', group: 'Students', capabilities: ['attendance.student.rollcall.mark'] },
  { id: 'attendance.alevel_roll_call', module: 'attendance', label: 'A-Level Roll Call', description: 'A-level section marking', href: '/hr/roll-call', group: 'Students', capabilities: ['attendance.student.rollcall.mark', 'attendance.student.rollcall.view'] },
  { id: 'attendance.timetables', module: 'attendance', label: 'Timetables', description: 'Weekly schedules and O/A-Level makeup reschedules', href: '/hr/timetables', group: 'Scheduling', capabilities: ['hr.timetable.view', 'hr.timetable.manage'] },
  { id: 'attendance.teaching_groups', module: 'attendance', label: 'Teaching Groups', description: 'Subject classes and student subject enrollment', href: '/hr/teaching-groups', group: 'Scheduling', capabilities: ['hr.timetable.view', 'hr.timetable.manage'] },
  { id: 'attendance.saturday_schedules', module: 'attendance', label: 'Saturday Schedules', description: 'Mandatory teacher Saturdays', href: '/hr/saturday-schedules', group: 'Scheduling', capabilities: ['hr.policies.manage'] },
  { id: 'attendance.shift_overrides', module: 'attendance', label: 'Shift Overrides', description: 'Override check-in/out time for a campus or segment on specific days', href: '/hr/shift-overrides', group: 'Scheduling', capabilities: ['hr.policies.manage'] },
  { id: 'attendance.academic_calendar', module: 'attendance', label: 'Academic Calendar', description: 'School year and events', href: '/hr/calendar', group: 'Scheduling', capabilities: ['hr.policies.manage'] },
  { id: 'attendance.settings', module: 'attendance', label: 'Attendance Settings', description: 'Rules and thresholds', href: '/hr/attendance-settings', group: 'Configuration', capabilities: ['hr.policies.manage'] },
  { id: 'attendance.class_modes', module: 'attendance', label: 'Class Modes', description: 'Online / offline configuration', href: '/hr/class-modes', group: 'Configuration', capabilities: ['hr.policies.manage'] },
  { id: 'attendance.zk_device_logs', module: 'attendance', label: 'ZK Device Logs', description: 'Biometric device data', href: '/attendance/zk-device-logs', group: 'Configuration', capabilities: ['system.permissions.manage'] },

  // ?? School Setup ?????????????????????????????????????????????????????????
  { id: 'school-setup.campuses', module: 'school-setup', label: 'Campuses', description: 'Branch locations and details', href: '/campuses', capabilities: ['academic.campuses.view'] },
  { id: 'school-setup.classes', module: 'school-setup', label: 'Classes', description: 'Grade and year configuration', href: '/classes', capabilities: ['academic.classes.view'] },
  { id: 'school-setup.sections', module: 'school-setup', label: 'Sections', description: 'Class subdivisions', href: '/sections', capabilities: ['academic.sections.view'] },
  { id: 'school-setup.segments', module: 'school-setup', label: 'Segments', description: 'Wings that group classes and staff', href: '/segments', capabilities: ['academic.classes.view'] },
  { id: 'school-setup.section_allocation', module: 'school-setup', label: 'Section Allocation Rules', description: 'Capacity and gender limits per campus/class/section', href: '/campuses/allocation-rules', capabilities: ['academic.campuses.view'] },
  { id: 'school-setup.house_balancer', module: 'school-setup', label: 'House Balancer', description: 'Random evenly balanced house redistribution', href: '/house-balancer', capabilities: ['academic.campuses.view'] },
  { id: 'school-setup.fee_types', module: 'school-setup', label: 'Fee Types', description: 'Fee head definitions', href: '/fee-types', capabilities: ['fee_admin.fee_types.view'] },
  { id: 'school-setup.discount_presets', module: 'school-setup', label: 'Discount Presets', description: 'Standard discount templates', href: '/discount-presets', capabilities: ['fee_admin.fee_types.view'] },
  { id: 'school-setup.banks', module: 'school-setup', label: 'Banks', description: 'Banking relationships', href: '/banks', capabilities: ['finance.banks.view'] },

  // ?? System ???????????????????????????????????????????????????????????????
  { id: 'system.people_access', module: 'system', label: 'People & Access', description: 'Create people, job assignment and ERP tile access', href: '/system/users', capabilities: ['system.users.view'] },
  { id: 'system.access_packs', module: 'system', label: 'Access Packs', description: 'Reusable tile bundles layered on top of roles', href: '/system/permissions', capabilities: ['system.permissions.manage'] },
  { id: 'system.activity_logs', module: 'system', label: 'Activity Logs', description: 'Full audit log across all modules', href: '/system/logs', capabilities: ['system.users.view'] },
  { id: 'system.backups', module: 'system', label: 'Database Backups', description: 'Data backup management', href: '/admin/backups', capabilities: ['system.backups.view'] },
  { id: 'system.developer_settings', module: 'system', label: 'Developer Settings', description: 'Technical configuration', href: '/admin/developer', capabilities: ['system.permissions.manage'] },
];

/** Exported so employee-field-tab-map.spec.ts can assert the map lines up. */
export const EMPLOYEE_DIRECTORY_ACTIONS_FOR_TEST = EMPLOYEE_DIRECTORY_ACTIONS;

export const MANIFEST_TILE_IDS = new Set(TILES_MANIFEST.map((t) => t.id));

/** Global address of a sub-permission. */
export function actionKey(tileId: string, actionId: string): string {
  return `${tileId}#${actionId}`;
}

export function parseActionKey(key: string): { tileId: string; actionId: string } | null {
  const at = key.indexOf('#');
  if (at <= 0 || at === key.length - 1) return null;
  return { tileId: key.slice(0, at), actionId: key.slice(at + 1) };
}

export const MANIFEST_ACTION_KEYS = new Set(
  TILES_MANIFEST.flatMap((t) => (t.actions ?? []).map((a) => actionKey(t.id, a.id))),
);

export const MANIFEST_EFFECTIVE_TILES = TILES_MANIFEST.map((t) => ({
  id: t.id,
  capabilities: t.capabilities,
  actions: (t.actions ?? []).map((a) => ({
    id: a.id,
    default: a.default ?? false,
    implies: a.implies ?? [],
  })),
  legacyFullAccessCapabilities: t.legacyFullAccessCapabilities ?? [],
}));

export function catalogFromManifest() {
  const byModule = new Map<string, Array<TileManifestEntry & { sort_order: number }>>();
  TILES_MANIFEST.forEach((tile, sort_order) => {
    const list = byModule.get(tile.module) ?? [];
    list.push({ ...tile, sort_order });
    byModule.set(tile.module, list);
  });
  return {
    modules: [...byModule.entries()].map(([id, moduleTiles]) => ({
      id,
      tiles: moduleTiles.map((t) => ({
        id: t.id,
        module: t.module,
        label: t.label,
        description: t.description,
        href: t.href,
        group: t.group ?? null,
        sort_order: t.sort_order,
        capabilities: t.capabilities,
        actions: (t.actions ?? []).map((a, i) => ({
          id: a.id,
          key: actionKey(t.id, a.id),
          label: a.label,
          description: a.description ?? null,
          default: a.default ?? false,
          implies: a.implies ?? [],
          sort_order: i,
        })),
      })),
    })),
  };
}
