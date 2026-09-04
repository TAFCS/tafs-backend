export type TileManifestEntry = {
  id: string;
  module: string;
  label: string;
  description: string;
  href: string;
  group?: string;
  capabilities: string[];
};

/**
 * Source of truth for ERP tiles. Synced to `access_tiles` on boot.
 * Edit this file (and seed a new capability key if needed) to split a tile
 * without a frontend deploy � the panel and nav read the catalog live.
 */
export const TILES_MANIFEST: TileManifestEntry[] = [
  // ?? Student & Profiling ??????????????????????????????????????????????????
  { id: 'student.quick_registration', module: 'student', label: 'Quick Registration', description: 'Unconfirmed admission intake', href: '/identity/quick-registration', capabilities: ['students.registration.view'] },
  { id: 'student.registration', module: 'student', label: 'Registration', description: 'New student intake', href: '/identity/register', capabilities: ['students.registration.view'] },
  { id: 'student.enrollments', module: 'student', label: 'Enrollments', description: 'Class and section assignment', href: '/enrollments', capabilities: ['students.enrollment.view'] },
  { id: 'student.directory', module: 'student', label: 'Student Directory', description: 'Search all students', href: '/identity/students', capabilities: ['students.directory.view'] },
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
  { id: 'hr.employee_directory', module: 'hr', label: 'Employee Directory', description: 'Staff profiles and records', href: '/hr/employees', capabilities: ['hr.employees.view'] },
  { id: 'hr.register_employee', module: 'hr', label: 'Register a Employee', description: 'Create new employee profile', href: '/hr/employees/new', capabilities: ['hr.employees.view'] },
  { id: 'hr.departments', module: 'hr', label: 'Departments', description: 'Departments and staff categories', href: '/hr/departments', capabilities: ['hr.employees.view'] },
  { id: 'hr.payroll', module: 'hr', label: 'Payroll', description: 'Salary processing', href: '/hr/payroll', capabilities: ['hr.payroll.view'] },
  { id: 'hr.payroll_rules', module: 'hr', label: 'Payroll Rules', description: 'EOBI, SESSI & income tax rates', href: '/hr/payroll/rules', capabilities: ['hr.payroll.view'] },
  { id: 'hr.security_deposits', module: 'hr', label: 'Security Deposits', description: 'Caution money plans across employees', href: '/hr/security-deposits', capabilities: ['hr.employees.view'] },
  { id: 'hr.employee_loans', module: 'hr', label: 'Employee Loans', description: 'Salary advance loans across employees', href: '/hr/employee-loans', capabilities: ['hr.employees.view'] },
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
