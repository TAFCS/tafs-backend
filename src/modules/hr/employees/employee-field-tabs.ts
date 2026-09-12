/**
 * Every field of CreateEmployeeDto / UpdateEmployeeDto, mapped to the tab that
 * owns it.
 *
 * PATCH /hr/employees/:id writes fields belonging to several tabs through one
 * route, so a single @RequireAction on it would be theatre: a caller holding
 * only `profile.edit` could PATCH `monthly_pay` straight through. Edits are
 * therefore authorised per field, against `<tab>.edit`.
 *
 * A field missing from this map is UNGUARDED -- employee-field-tab-map.spec.ts
 * asserts every DTO key appears here, so a new field fails CI rather than
 * shipping an unguarded write.
 */
export const EMPLOYEE_FIELD_TAB_MAP: Record<string, string> = {
  // ── Profile tab ──
  full_name: 'profile', father_name: 'profile', mother_name: 'profile',
  cnic: 'profile', date_of_birth: 'profile', personal_phone: 'profile',
  secondary_phone: 'profile', personal_email: 'profile', address: 'profile',
  notes: 'profile',
  emergency_contact_name: 'profile', emergency_contact_phone: 'profile',
  emergency_contact_relationship: 'profile',
  photo_url: 'profile', father_photo_url: 'profile', father_cnic: 'profile',
  mother_photo_url: 'profile', mother_cnic: 'profile',
  spouse_name: 'profile', spouse_cnic: 'profile', spouse_photo_url: 'profile',
  previous_employers: 'profile',

  // ── Employment tab ──
  employee_code: 'employment', employee_code_dep: 'employment',
  employee_code_number: 'employment', department_id: 'employment',
  staff_category_id: 'employment', job_title: 'employment',
  campus_id: 'employment', join_date: 'employment',
  job_description: 'employment', segment_id: 'employment',
  employment_type: 'employment', reporting_manager_id: 'employment',

  // ── Schedule & Pay tab ──
  reporting_time: 'schedule_pay', leaving_time: 'schedule_pay',
  check_in_source: 'schedule_pay', late_relaxation_minutes: 'schedule_pay',
  days_per_week: 'schedule_pay', monthly_pay: 'schedule_pay',
  payroll_enabled: 'schedule_pay',
  account_number: 'schedule_pay', bank_name: 'schedule_pay',

  // ── Class & Sections tab ──
  class_section_assignments: 'classes',

  // ── Portal Account tab ──
  portal_account: 'portal', user_id: 'portal',
};

/**
 * employment_status has its own route (PATCH :id/status) and its own action,
 * so it is authorised against that rather than against `employment.edit`.
 */
export const EMPLOYEE_FIELD_ACTION_OVERRIDES: Record<string, string> = {
  employment_status: 'status.change',
};

export const EMPLOYEE_DIRECTORY_TILE_ID = 'hr.employee_directory';
