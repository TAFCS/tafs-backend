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
  /**
   * Where the tile is used. Omitted means the web ERP.
   *
   * `staff_app` tiles are tabs in the TAFS Staff App (Flutter). They are
   * granted, packed and denied exactly like web tiles, but the web launcher
   * never renders them (mergeNavModules only maps modules it knows) and the
   * People & Access panel draws them in their own Staff App section. `href`
   * on these is a `staff-app://` label, not a web route.
   */
  surface?: 'web' | 'staff_app';
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

/**
 * Sub-permissions for Student Overrides (/studentwise-fees).
 *
 * Route-shaped, like the Student Directory: the page has no multi-tab write,
 * it has one grid plus a ring of side operations, and each of those operations
 * is a different amount of money someone can move. Reading a student's
 * schedule, writing off a head, and wiping every head for a student were all
 * one permission before this.
 *
 * The three at the bottom are the danger zone -- they rewrite or destroy heads
 * that may already be paid and receipted.
 */
const STUDENT_OVERRIDES_ACTIONS: TileAction[] = [
  { id: 'view', label: 'Open student fees', description: 'Search a student and read their fee schedule, discounts, installments and bundles', default: true },

  { id: 'schedule.edit', label: 'Edit the fee schedule', description: 'Add, edit and remove fee heads in the grid and save them', implies: ['view'] },
  { id: 'discount.manage', label: 'Manage discounts', description: 'Add and remove custom discount rows', implies: ['view'] },
  { id: 'scholarship.manage', label: 'Set scholarship', description: 'Set one scholarship percentage across every MTF row for a year', implies: ['view'] },
  { id: 'bundle.manage', label: 'Manage bundles', description: 'Bundle heads together and dissolve bundles', implies: ['view'] },
  { id: 'installment.manage', label: 'Manage installment plans', description: 'Create, edit and delete installment plans', implies: ['view'] },
  { id: 'waive', label: 'Waive a fee head', description: 'Write off a head or its voucher, and reverse a waiver', implies: ['view'] },
  { id: 'flags.edit', label: 'Edit fee concession flags', description: 'Complementary and fee-endowment flags on the student', implies: ['view'] },
  { id: 'audit.view', label: 'Open the finance audit log', implies: ['view'] },

  { id: 'bulk_ops.view', label: 'Open bulk operations', description: 'Preview what a bulk add or delete would do, without running it', implies: ['view'] },
  { id: 'bulk_ops.add', label: 'Bulk add fee heads', description: 'Add a head, or a range of months, to a whole class or section', implies: ['bulk_ops.view'] },
  { id: 'bulk_ops.delete', label: 'Bulk delete fee heads', implies: ['bulk_ops.view'] },

  { id: 'transfer', label: 'Transfer heads to another year', description: 'Danger zone: rewrites heads that may already be paid', implies: ['view'] },
  { id: 'reset', label: 'Reset every head for a student', description: 'Danger zone: deletes the student\'s whole schedule', implies: ['view'] },
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

// School Setup master data. Reads (GET) stay undecorated: campuses, classes,
// sections, fee types and segments feed dropdowns on nearly every page. Only
// writes exclusive to each admin page carry an action. Campuses additionally
// enforce scope on every write (a campus-scoped admin may only change their
// own campus, and may not create one); the section-mapping PUT is shared with
// Student Overrides, so it is scoped but carries no Campuses action.
const CAMPUSES_ACTIONS: TileAction[] = [
  { id: 'view', label: 'View campuses', default: true },

  { id: 'create', label: 'Add a campus', implies: ['view'] },
  { id: 'edit', label: 'Edit campuses', implies: ['view'] },
  { id: 'delete', label: 'Delete a campus', implies: ['view'] },
  { id: 'classes.manage', label: 'Add/remove classes and sections at a campus', implies: ['view'] },
];

const CLASSES_ACTIONS: TileAction[] = [
  { id: 'view', label: 'View classes', default: true },

  { id: 'create', label: 'Add a class', implies: ['view'] },
  { id: 'edit', label: 'Edit classes', implies: ['view'] },
  { id: 'delete', label: 'Delete a class', implies: ['view'] },
];

const SECTIONS_ACTIONS: TileAction[] = [
  { id: 'view', label: 'View sections', default: true },

  { id: 'create', label: 'Add a section', implies: ['view'] },
  { id: 'edit', label: 'Edit sections', implies: ['view'] },
  { id: 'delete', label: 'Delete a section', implies: ['view'] },
];

// `edit` covers renaming a segment AND the campus-map (which segments run at
// which campus — scoped: a campus-scoped admin may only map their own campus).
const SEGMENTS_ACTIONS: TileAction[] = [
  { id: 'view', label: 'View segments', default: true },

  { id: 'create', label: 'Add a segment', implies: ['view'] },
  { id: 'edit', label: 'Edit segments and the campus map', implies: ['view'] },
  { id: 'delete', label: 'Delete a segment', implies: ['view'] },
];

const FEE_TYPES_ACTIONS: TileAction[] = [
  { id: 'view', label: 'View fee types', default: true },

  { id: 'create', label: 'Add a fee type', implies: ['view'] },
  { id: 'edit', label: 'Edit fee types', implies: ['view'] },
  { id: 'delete', label: 'Delete a fee type', implies: ['view'] },
];

const DISCOUNT_PRESETS_ACTIONS: TileAction[] = [
  { id: 'view', label: 'View discount presets', default: true },

  { id: 'create', label: 'Add a discount preset', implies: ['view'] },
  { id: 'edit', label: 'Edit or deactivate a preset', implies: ['view'] },
  { id: 'delete', label: 'Delete a preset', implies: ['view'] },
];

// Tab-shaped, like Employee/Student Directory: PUT /users/:id and
// PUT /users/:id/access each write fields belonging to more than one tab
// through one route, so both are field-partitioned (UsersService.updateUser
// against USER_FIELD_TAB_MAP; AccessService.setUserAccess by DTO key) rather
// than carrying a single @RequireAction. `role` is a field neither tab-action
// covers — changing it requires the actor to BE SUPER_ADMIN, not merely hold
// an action, since the generic CASL mapper turns almost any granted
// capability into full Manage and role is how SUPER_ADMIN itself is granted.
// A campus-scoped holder of this tile is also restricted to managing users
// within, and granting scope no wider than, their own scope — see
// AccessService.assertCanManageUser/assertGrantableScope and the
// scope/tile-permission handoff §8, which left this as an open decision.
const PEOPLE_ACCESS_ACTIONS: TileAction[] = [
  { id: 'view', label: 'Open People & Access', description: 'See the account list and open a record', default: true },

  { id: 'identity.edit', label: 'Edit identity', description: 'Name, password, active status', implies: ['view'] },
  { id: 'job.edit', label: 'Edit job assignment', description: 'Legacy campus/class fields', implies: ['view'] },
  { id: 'reveal_password', label: 'Reveal a stored password', implies: ['view'] },

  { id: 'access.edit', label: 'Edit access', description: 'Packs, tiles, and sub-permission grants', implies: ['view'] },
  { id: 'scope.edit', label: 'Edit data scope', implies: ['view'] },

  { id: 'create', label: 'Create a person', implies: ['view'] },
];

// Route-shaped, single tile — no other tile shares any route on
// FinancialReportsController. The real fix here was scope, not actions:
// buildStudentWhere/buildMatrixStudentWhere only ever applied the legacy
// single-campus check (applyStudentScope); a caller's own segment/department/
// staff-category-adjacent restrictions were never enforced, and a client
// could simply omit campus_id from the query to bypass even that. Both
// helpers now AND the universal scope fragment on top, same pattern as
// students.service.ts.
const FINANCIAL_REPORTS_ACTIONS: TileAction[] = [
  { id: 'view', label: 'View reports', default: true },

  { id: 'export', label: 'Export a report to Excel', implies: ['view'] },
  { id: 'snapshot.manage', label: 'Create or delete a fee-heads snapshot', implies: ['view'] },
  { id: 'snapshot.finalize', label: 'Finalize a snapshot', implies: ['view'] },
];

// GET /by-class is shared with Student Overrides (default-fee suggestions)
// and deliberately left undecorated — see class-fee-schedule.controller.ts.
// A null campus_id row is a genuine global default, not unassigned data, so
// it stays visible to everyone rather than being hidden by scope; a scoped
// caller may also never create/move a row TO campus_id null (that would let
// them affect every campus). See ClassFeeScheduleService.
const CLASS_FEE_SCHEDULE_ACTIONS: TileAction[] = [
  { id: 'view', label: 'View class fee schedules', default: true },

  { id: 'create', label: 'Add a fee schedule entry', implies: ['view'] },
  { id: 'edit', label: 'Edit fee schedule entries', implies: ['view'] },
  { id: 'delete', label: 'Delete a fee schedule entry', implies: ['view'] },
  { id: 'copy_history', label: 'Copy a year\'s schedule forward', implies: ['view'] },
];

// `create` (POST /vouchers, bare) is confirmed exclusive to the Single
// Voucher Issuance page — no other tile's page calls it, unlike generate-pdf/
// arrears/by-student on the same controller, which stay undecorated because
// they ARE shared with Vouchers and Receive Deposit. The real fix was scope:
// create() had no target-student check at all; VouchersService.
// assertCanIssueFor() closes it without touching create() itself, since
// create() is also called in-process by the bulk pipeline's async job.
const SINGLE_VOUCHER_ACTIONS: TileAction[] = [
  { id: 'view', label: 'Open Single Voucher Issuance', default: true },

  { id: 'create', label: 'Issue a voucher', implies: ['view'] },
];

// `startJob` is ALSO reachable from POST /vouchers/batch-issue
// (vouchers.controller.ts) — that route uses @RequireAnyAction across this
// tile and finance.vouchers#edit, so a Vouchers-only holder using the
// existing-voucher batch-reissue flow isn't locked out. The real gap fixed
// here was scope, not just actions: preview/startJob had NO campus/student
// scope enforcement at all — a client could request/generate vouchers for
// any campus, or any student cc directly, bypassing campus_ids entirely.
const BULK_VOUCHER_ACTIONS: TileAction[] = [
  { id: 'view', label: 'View bulk voucher jobs', default: true },

  { id: 'start', label: 'Start a bulk voucher job', implies: ['view'] },
];

// VouchersController is shared by at least 6 tiles (Vouchers, Fee Challan,
// Receive Deposit, Student Overrides, Payment History, and a Transfers form)
// with no clean per-route ownership — see the scope/tile-permission handoff.
// Deliberately minimal: only the routes exclusive to (or safely assignable
// to) the Vouchers directory itself are covered. Every shared route (waive,
// split, generate-pdf, deposit, clear-deposit, create, arrears, by-student,
// the batch-* and pending-release/* routes) is left undecorated, same as any
// other not-yet-rolled-out tile — decorating them here would lock out users
// of the OTHER tiles that depend on them without giving them an equivalent
// grant. Widen this only alongside a matching rollout of those other tiles.
const VOUCHERS_ACTIONS: TileAction[] = [
  { id: 'view', label: 'Open vouchers', description: 'See the voucher list and open a record', default: true },

  { id: 'edit', label: 'Edit a voucher', description: 'Issue date, due date, validity, status, late fee, bank account, section', implies: ['view'] },
  { id: 'delete', label: 'Delete a voucher', description: 'Single or bulk', implies: ['view'] },
];

// Standalone — no other tile shares any pending-release route. The real fix
// here was scope: findPendingRelease/releaseVouchers/releaseByBulkJobId had
// NO campus/class/section enforcement at all, so a scoped user could
// release (make visible to parents) a voucher at any campus by id. Now the
// list is floor-scoped and release silently skips out-of-scope candidates,
// the same way it already silently skips already-released ones.
const PENDING_RELEASE_ACTIONS: TileAction[] = [
  { id: 'view', label: 'View held vouchers', default: true },

  { id: 'release', label: 'Release a voucher to parents', implies: ['view'] },
];

// This tile owns NO route of its own — GET /students/:id/payment-history is
// the Student Directory's own route (student.directory#payment_history.view,
// already shipped), widened here with @RequireAnyAction so a Payment History
// holder who never got the Student Directory tile can still use it.
// clear-deposit IS confirmed exclusive to this page (no other tile calls it,
// unlike deposit/waive/generate-pdf on the same controller) so it gets its
// own action directly. Real scope fix alongside: getPaymentHistory had no
// scope check at all — any campus's student payment history was readable by
// id; now 404 not 403, same as everywhere else.
const PAYMENT_HISTORY_ACTIONS: TileAction[] = [
  { id: 'view', label: 'View payment history', default: true },

  { id: 'clear_deposit', label: 'Clear a deposit', implies: ['view'] },
];

// bank-accounts.controller.ts previously had NO capability check at all
// (JwtStaffGuard only) — any logged-in staff could create/edit/delete a bank
// account. `finance.banks.edit` was in the permission catalog but assigned to
// no role, so the real check now locks writes to SUPER_ADMIN until it's
// deliberately granted (decided over silently seeding it onto whatever roles
// happened to hold `finance.banks.view`, which was never actually checked).
// GET /bank-accounts (list) is deliberately left uncovered here — it's read
// by fee-challan, the deposit page and the Vouchers page just to populate a
// bank picker, unrelated to who may administer bank accounts.
const BANKS_ACTIONS: TileAction[] = [
  { id: 'view', label: 'View bank accounts', default: true },

  { id: 'create', label: 'Add a bank account', implies: ['view'] },
  { id: 'edit', label: 'Edit a bank account', implies: ['view'] },
  { id: 'delete', label: 'Delete a bank account', implies: ['view'] },
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
  { id: 'finance.financial_reports', module: 'finance', label: 'Financial Reports', description: 'Fee heads (accrual), deposits (cash), a student x month fee matrix, and the defaulters list, with filters and exports', href: '/financial-reports', capabilities: ['system.analytics.view'], actions: FINANCIAL_REPORTS_ACTIONS, legacyFullAccessCapabilities: ['system.analytics.finalize'] },
  { id: 'finance.class_fee_schedule', module: 'finance', label: 'Class Fee Schedule', description: 'Per-class fee configuration', href: '/classwise-fees-schedule', capabilities: ['fee_admin.classwise_schedule.view'], actions: CLASS_FEE_SCHEDULE_ACTIONS, legacyFullAccessCapabilities: ['fee_admin.classwise_schedule.edit'] },
  { id: 'finance.student_overrides', module: 'finance', label: 'Student Overrides', description: 'Individual fee adjustments', href: '/studentwise-fees', capabilities: ['fee_admin.studentwise_schedule.view'], actions: STUDENT_OVERRIDES_ACTIONS, legacyFullAccessCapabilities: ['fee_admin.studentwise_schedule.edit'] },
  { id: 'finance.single_voucher', module: 'finance', label: 'Single Voucher Issuance', description: 'Print individual fee slips', href: '/fee-challan', capabilities: ['finance.vouchers.view'], actions: SINGLE_VOUCHER_ACTIONS, legacyFullAccessCapabilities: ['finance.vouchers.generate_single'] },
  { id: 'finance.bulk_voucher', module: 'finance', label: 'Bulk Voucher Issuance', description: 'Generate multiple vouchers', href: '/bulk-voucher', capabilities: ['finance.vouchers.generate_bulk'], actions: BULK_VOUCHER_ACTIONS, legacyFullAccessCapabilities: ['finance.vouchers.generate_bulk'] },
  { id: 'finance.vouchers', module: 'finance', label: 'Vouchers', description: 'All issued vouchers', href: '/vouchers', capabilities: ['finance.vouchers.view'], actions: VOUCHERS_ACTIONS, legacyFullAccessCapabilities: ['finance.vouchers.generate_single', 'finance.vouchers.generate_bulk', 'finance.vouchers.download', 'finance.vouchers.split_partial'] },
  { id: 'finance.pending_release', module: 'finance', label: 'Pending Release', description: 'Held vouchers awaiting parent visibility', href: '/pending-release', capabilities: ['finance.vouchers.release'], actions: PENDING_RELEASE_ACTIONS, legacyFullAccessCapabilities: ['finance.vouchers.release'] },
  { id: 'finance.payment_history', module: 'finance', label: 'Payment History', description: 'Payment transaction log', href: '/payment-history', capabilities: ['finance.vouchers.view'], actions: PAYMENT_HISTORY_ACTIONS, legacyFullAccessCapabilities: ['finance.vouchers.download'] },
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
  { id: 'school-setup.campuses', module: 'school-setup', label: 'Campuses', description: 'Branch locations and details', href: '/campuses', capabilities: ['academic.campuses.view'], actions: CAMPUSES_ACTIONS, legacyFullAccessCapabilities: ['academic.campuses.edit'] },
  { id: 'school-setup.classes', module: 'school-setup', label: 'Classes', description: 'Grade and year configuration', href: '/classes', capabilities: ['academic.classes.view'], actions: CLASSES_ACTIONS, legacyFullAccessCapabilities: ['academic.classes.edit'] },
  { id: 'school-setup.sections', module: 'school-setup', label: 'Sections', description: 'Class subdivisions', href: '/sections', capabilities: ['academic.sections.view'], actions: SECTIONS_ACTIONS, legacyFullAccessCapabilities: ['academic.sections.edit'] },
  { id: 'school-setup.segments', module: 'school-setup', label: 'Segments', description: 'Wings that group classes and staff', href: '/segments', capabilities: ['academic.classes.view'], actions: SEGMENTS_ACTIONS, legacyFullAccessCapabilities: ['hr.employees.edit'] },
  { id: 'school-setup.section_allocation', module: 'school-setup', label: 'Section Allocation Rules', description: 'Capacity and gender limits per campus/class/section', href: '/campuses/allocation-rules', capabilities: ['academic.campuses.view'] },
  { id: 'school-setup.house_balancer', module: 'school-setup', label: 'House Balancer', description: 'Random evenly balanced house redistribution', href: '/house-balancer', capabilities: ['academic.campuses.view'] },
  { id: 'school-setup.fee_types', module: 'school-setup', label: 'Fee Types', description: 'Fee head definitions', href: '/fee-types', capabilities: ['fee_admin.fee_types.view'], actions: FEE_TYPES_ACTIONS, legacyFullAccessCapabilities: ['fee_admin.fee_types.edit'] },
  { id: 'school-setup.discount_presets', module: 'school-setup', label: 'Discount Presets', description: 'Standard discount templates', href: '/discount-presets', capabilities: ['fee_admin.fee_types.view'], actions: DISCOUNT_PRESETS_ACTIONS, legacyFullAccessCapabilities: ['fee_admin.fee_types.edit'] },
  { id: 'school-setup.banks', module: 'school-setup', label: 'Banks', description: 'Banking relationships', href: '/banks', capabilities: ['finance.banks.view'], actions: BANKS_ACTIONS, legacyFullAccessCapabilities: ['finance.banks.edit'] },

  // ?? TAFS Staff App ???????????????????????????????????????????????????????
  // One tile per permission-gated tab. The app checks the capability keys
  // directly (tafs-staff-app employee_portal_access.dart), so these ids are
  // for granting and display only -- renaming the KEYS would break the app.
  // Allowed for every employee through the "Employee self-service" system pack
  // (migration 20260916130000), and assigned automatically when an employee
  // profile gets a login.
  { id: 'staff_app.attendance', module: 'staff_app', surface: 'staff_app', label: 'Attendance', description: 'Own attendance calendar, day details and objections', href: 'staff-app://attendance', capabilities: ['attendance.self.view'] },
  { id: 'staff_app.timetable', module: 'staff_app', surface: 'staff_app', label: 'Timetable', description: 'Own weekly class schedule', href: 'staff-app://timetable', capabilities: ['hr.timetable.self_view'] },
  { id: 'staff_app.payroll', module: 'staff_app', surface: 'staff_app', label: 'Payroll', description: 'Own payslips (also needs payroll enabled on the employee)', href: 'staff-app://payroll', capabilities: ['payroll.self.view'] },
  { id: 'staff_app.leave', module: 'staff_app', surface: 'staff_app', label: 'Apply for Leave', description: 'Submit and track own leave requests', href: 'staff-app://leave', capabilities: ['hr.leave.apply'] },

  // ?? System ???????????????????????????????????????????????????????????????
  { id: 'system.people_access', module: 'system', label: 'People & Access', description: 'Create people, job assignment and ERP tile access', href: '/system/users', capabilities: ['system.users.view'], actions: PEOPLE_ACCESS_ACTIONS, legacyFullAccessCapabilities: ['system.users.edit', 'system.permissions.manage'] },
  { id: 'system.access_packs', module: 'system', label: 'Access Packs', description: 'Reusable tile bundles layered on top of roles', href: '/system/permissions', capabilities: ['system.permissions.manage'] },
  { id: 'system.activity_logs', module: 'system', label: 'Activity Logs', description: 'Full audit log across all modules', href: '/system/logs', capabilities: ['system.users.view'] },
  { id: 'system.backups', module: 'system', label: 'Database Backups', description: 'Data backup management', href: '/admin/backups', capabilities: ['system.backups.view'] },
  { id: 'system.developer_settings', module: 'system', label: 'Developer Settings', description: 'Technical configuration', href: '/admin/developer', capabilities: ['system.permissions.manage'] },
];

/** Exported so employee-field-tab-map.spec.ts can assert the map lines up. */
export const EMPLOYEE_DIRECTORY_ACTIONS_FOR_TEST = EMPLOYEE_DIRECTORY_ACTIONS;

/** The system pack that carries every staff_app tile for all employees. */
export const EMPLOYEE_SELF_SERVICE_PACK = 'Employee self-service';

export const MANIFEST_TILE_IDS = new Set(TILES_MANIFEST.map((t) => t.id));

/** Global address of a sub-permission. */
export function actionKey(tileId: string, actionId: string): string {
  return `${tileId}#${actionId}`;
}

/**
 * Stands for "every action of this tile" inside an `actions` claim.
 *
 * Why it exists: `actions` rides on the JWT, the JWT rides in the `tafs_access`
 * cookie, and browsers drop a cookie over 4096 bytes silently -- the user then
 * looks logged out with nothing in the logs. A user holding a tile's legacy
 * bridge holds every one of its actions, and spelling all 28 of them out cost
 * ~1KB on its own. One wildcard says the same thing in 24 bytes.
 *
 * Only the two READERS of the claim understand it (TileActionGuard and the
 * webapp's useTileAccess). Everything that reasons about individual actions --
 * computeEffectiveAccess, the access catalog, the People & Access editor --
 * keeps working with the expanded list.
 */
export const ALL_ACTIONS_WILDCARD = '*';

/**
 * Losslessly shrinks an expanded action list for transport on the JWT: a tile
 * whose every manifest action is present collapses to `tileId#*`.
 *
 * Lossless because the wildcard is only emitted when the holder really does
 * have all of them, so `holds(tile#x)` gives the same answer either way.
 */
export function compactActionKeys(actionKeys: string[]): string[] {
  const held = new Set(actionKeys);
  const out: string[] = [];
  const collapsed = new Set<string>();

  for (const tile of TILES_MANIFEST) {
    const actions = tile.actions ?? [];
    if (actions.length < 2) continue; // nothing to save
    if (actions.every((a) => held.has(actionKey(tile.id, a.id)))) {
      out.push(actionKey(tile.id, ALL_ACTIONS_WILDCARD));
      collapsed.add(tile.id);
    }
  }

  for (const key of actionKeys) {
    const parsed = parseActionKey(key);
    // An unparseable or unknown key is passed through untouched rather than
    // dropped: this function must never be the thing that revokes access.
    if (parsed && collapsed.has(parsed.tileId)) continue;
    out.push(key);
  }
  return out;
}

/**
 * True when `held` (an actions claim, compacted or not) covers `wanted`.
 *
 * The one place the wildcard is interpreted on the server. Tokens issued
 * before compaction shipped carry expanded lists and still match on the first
 * check, so both shapes work for the 90 days they overlap.
 */
export function actionsCover(held: Set<string> | readonly string[], wanted: string): boolean {
  const set = held instanceof Set ? held : new Set(held);
  if (set.has(wanted)) return true;
  const parsed = parseActionKey(wanted);
  return parsed != null && set.has(actionKey(parsed.tileId, ALL_ACTIONS_WILDCARD));
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
        surface: t.surface ?? 'web',
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
export const PEOPLE_ACCESS_ACTIONS_FOR_TEST = PEOPLE_ACCESS_ACTIONS;
