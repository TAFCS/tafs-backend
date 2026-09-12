import {
  EMPLOYEE_FIELD_ACTION_OVERRIDES,
  EMPLOYEE_FIELD_TAB_MAP,
} from './employee-field-tabs';
import { EMPLOYEE_DIRECTORY_ACTIONS_FOR_TEST } from '../../access/tiles.manifest';

/**
 * Every field CreateEmployeeDto / UpdateEmployeeDto can carry, listed here by
 * hand. Kept as a literal rather than reflected off the class so the spec has
 * no runtime dependency on the service (which pulls in prisma and ESM-only
 * uuid). Adding a field to the DTO without adding it here fails this spec --
 * which is the point.
 */
const DTO_FIELDS = [
  'portal_account', 'user_id', 'cnic', 'join_date', 'employment_type',
  'employment_status', 'department_id', 'reporting_manager_id', 'employee_code',
  'employee_code_dep', 'employee_code_number', 'full_name', 'father_name',
  'mother_name', 'date_of_birth', 'address', 'personal_phone',
  'secondary_phone', 'personal_email', 'job_title', 'staff_category_id',
  'segment_id', 'job_description', 'notes', 'reporting_time', 'leaving_time',
  'check_in_source', 'late_relaxation_minutes', 'monthly_pay',
  'payroll_enabled', 'campus_id', 'days_per_week', 'photo_url',
  'father_photo_url', 'father_cnic', 'mother_photo_url', 'mother_cnic',
  'spouse_name', 'spouse_cnic', 'spouse_photo_url', 'account_number',
  'bank_name', 'emergency_contact_name', 'emergency_contact_phone',
  'emergency_contact_relationship', 'class_section_assignments',
  'previous_employers',
];

/**
 * PATCH /hr/employees/:id writes fields belonging to several tabs through one
 * route, so tab-level permissions only mean something if EVERY field is mapped.
 * An unmapped field is an unguarded write.
 */
describe('EMPLOYEE_FIELD_TAB_MAP', () => {
  it('covers every field the DTO can carry', () => {
    const known = new Set([
      ...Object.keys(EMPLOYEE_FIELD_TAB_MAP),
      ...Object.keys(EMPLOYEE_FIELD_ACTION_OVERRIDES),
    ]);
    const unmapped = DTO_FIELDS.filter((f) => !known.has(f));

    // Failing here means a field was added to CreateEmployeeDto without
    // deciding which tab owns it. Add it to EMPLOYEE_FIELD_TAB_MAP.
    expect(unmapped).toEqual([]);
  });

  it('maps nothing that is not a real DTO field', () => {
    const dto = new Set(DTO_FIELDS);
    const stale = Object.keys(EMPLOYEE_FIELD_TAB_MAP).filter((f) => !dto.has(f));
    expect(stale).toEqual([]);
  });

  it('maps every tab to an edit action the manifest declares', () => {
    const declared = new Set(EMPLOYEE_DIRECTORY_ACTIONS_FOR_TEST.map((a) => a.id));
    const missing = [...new Set(Object.values(EMPLOYEE_FIELD_TAB_MAP))]
      .map((tab) => `${tab}.edit`)
      .filter((actionId) => !declared.has(actionId));

    expect(missing).toEqual([]);
  });

  it('points every override at a declared action', () => {
    const declared = new Set(EMPLOYEE_DIRECTORY_ACTIONS_FOR_TEST.map((a) => a.id));
    const missing = Object.values(EMPLOYEE_FIELD_ACTION_OVERRIDES).filter(
      (actionId) => !declared.has(actionId),
    );
    expect(missing).toEqual([]);
  });

  it('never maps a field to both a tab and an override', () => {
    const both = Object.keys(EMPLOYEE_FIELD_ACTION_OVERRIDES).filter(
      (f) => EMPLOYEE_FIELD_TAB_MAP[f] !== undefined,
    );
    expect(both).toEqual([]);
  });
});
