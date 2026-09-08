import ExcelJS from 'exceljs';

export interface EmployeeProfileForExport {
  id: number;
  employee_code: string | null;
  employee_code_dep: string | null;
  employee_code_number: string | null;
  full_name: string | null;
  cnic: string | null;
  date_of_birth: Date | string | null;
  join_date: Date | string | null;
  employment_status: string | null;
  employment_type?: string | null;
  is_permanent_employee: boolean | null;
  job_title: string | null;
  job_description: string | null;
  monthly_pay: any;
  payroll_enabled?: boolean | null;
  reporting_time: Date | string | null;
  leaving_time: Date | string | null;
  days_per_week: number | null;
  late_relaxation_minutes: number | null;
  check_in_source: string | null;
  bank_name: string | null;
  account_number: string | null;
  address: string | null;
  personal_phone: string | null;
  secondary_phone?: string | null;
  personal_email: string | null;
  father_name: string | null;
  father_cnic?: string | null;
  mother_name: string | null;
  mother_cnic?: string | null;
  spouse_name: string | null;
  spouse_cnic: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_relationship: string | null;
  photo_url: string | null;
  notes: string | null;
  campuses?: { campus_name: string } | null;
  departments?: { name: string } | null;
  staff_categories?: { name: string } | null;
  segments?: { name: string } | null;
  reporting_manager?: { full_name: string | null; users?: { full_name: string | null } | null } | null;
  users?: { username: string; email: string | null; full_name?: string | null } | null;
  employee_class_section_assignments?: Array<{
    classes?: { description?: string; class_code?: string } | null;
    sections?: { description?: string } | null;
  }>;
  device_user_mappings?: Array<{
    device_pin: string;
    device_sn: string;
    is_active: boolean;
  }>;
}

function formatDate(d: Date | string | null | undefined): string {
  if (!d) return '';
  const dateObj = new Date(d);
  if (isNaN(dateObj.getTime())) return '';
  return dateObj.toISOString().split('T')[0];
}

function formatTime(d: Date | string | null | undefined): string {
  if (!d) return '';
  const dateObj = new Date(d);
  if (isNaN(dateObj.getTime())) return '';
  const hours = String(dateObj.getUTCHours()).padStart(2, '0');
  const minutes = String(dateObj.getUTCMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function formatAssignments(assignments?: EmployeeProfileForExport['employee_class_section_assignments']): string {
  if (!assignments || !assignments.length) return '';
  const assignmentsMap: Record<string, string[]> = {};
  for (const a of assignments) {
    const className = a.classes ? (a.classes.description || a.classes.class_code || 'Class') : 'Class';
    const secName = a.sections ? a.sections.description : '';
    if (!assignmentsMap[className]) assignmentsMap[className] = [];
    if (secName) assignmentsMap[className].push(secName);
  }
  return Object.entries(assignmentsMap)
    .map(([cls, secs]) => `${cls}${secs.length ? `: ${secs.join(', ')}` : ''}`)
    .join('; ');
}

function getActiveDeviceMapping(emp: EmployeeProfileForExport) {
  const activeMappings = (emp.device_user_mappings || []).filter(m => m.is_active !== false);
  return activeMappings.length > 0 ? activeMappings[0] : null;
}

export const EMPLOYEE_COLUMNS_CONFIG: Record<
  string,
  { header: string; width: number; getValue: (emp: EmployeeProfileForExport) => any }
> = {
  // Employee Details
  full_name: { header: 'Employee Name', width: 25, getValue: (e) => e.full_name || '' },
  employee_code: { header: 'Employee Code', width: 16, getValue: (e) => e.employee_code || '' },
  cnic: { header: 'CNIC', width: 18, getValue: (e) => e.cnic || '' },
  date_of_birth: { header: 'Date of Birth', width: 15, getValue: (e) => formatDate(e.date_of_birth) },
  personal_phone: { header: 'Personal Phone', width: 18, getValue: (e) => e.personal_phone || '' },
  secondary_phone: { header: 'Secondary Phone', width: 18, getValue: (e) => e.secondary_phone || '' },
  personal_email: { header: 'Personal Email', width: 25, getValue: (e) => e.personal_email || '' },
  address: { header: 'Residential Address', width: 35, getValue: (e) => e.address || '' },
  photo_url: { header: 'Photo URL', width: 30, getValue: (e) => e.photo_url || '' },

  // Placement & Role
  campus: { header: 'Campus', width: 20, getValue: (e) => e.campuses?.campus_name || '' },
  department: { header: 'Department', width: 20, getValue: (e) => e.departments?.name || '' },
  category: { header: 'Staff Category', width: 22, getValue: (e) => e.staff_categories?.name || '' },
  segment: { header: 'Segment', width: 18, getValue: (e) => e.segments?.name || '' },
  job_title: { header: 'Job Title', width: 22, getValue: (e) => e.job_title || '' },
  job_description: { header: 'Job Description', width: 30, getValue: (e) => e.job_description || '' },
  class_section_assignments: {
    header: 'Class-Section Assignments',
    width: 30,
    getValue: (e) => formatAssignments(e.employee_class_section_assignments),
  },
  employment_status: { header: 'Employment Status', width: 18, getValue: (e) => e.employment_status || 'ACTIVE' },
  employment_type: { header: 'Employment Type', width: 18, getValue: (e) => e.employment_type || '' },
  is_permanent: { header: 'Is Permanent', width: 15, getValue: (e) => (e.is_permanent_employee ? 'Yes' : 'No') },
  join_date: { header: 'Date of Joining', width: 15, getValue: (e) => formatDate(e.join_date) },
  reporting_manager: {
    header: 'Reporting Manager',
    width: 22,
    getValue: (e) => e.reporting_manager?.users?.full_name || e.reporting_manager?.full_name || '',
  },

  // Timing & Biometrics
  reporting_time: { header: 'Reporting Time', width: 15, getValue: (e) => formatTime(e.reporting_time) },
  leaving_time: { header: 'Leaving Time', width: 15, getValue: (e) => formatTime(e.leaving_time) },
  days_per_week: {
    header: 'Days Per Week',
    width: 14,
    getValue: (e) => (e.days_per_week !== null && e.days_per_week !== undefined ? e.days_per_week : ''),
  },
  late_relaxation_minutes: {
    header: 'Late Relaxation (Mins)',
    width: 20,
    getValue: (e) =>
      e.late_relaxation_minutes !== null && e.late_relaxation_minutes !== undefined
        ? e.late_relaxation_minutes
        : '',
  },
  check_in_source: { header: 'Check-In Source', width: 16, getValue: (e) => e.check_in_source || '' },
  device_pin: {
    header: 'Biometric Device PIN',
    width: 20,
    getValue: (e) => {
      const m = getActiveDeviceMapping(e);
      return m ? m.device_pin : '';
    },
  },
  device_sn: {
    header: 'Biometric Device SN',
    width: 22,
    getValue: (e) => {
      const m = getActiveDeviceMapping(e);
      return m ? m.device_sn : '';
    },
  },

  // Payroll & Banking
  monthly_pay: { header: 'Monthly Pay (PKR)', width: 18, getValue: (e) => (e.monthly_pay ? Number(e.monthly_pay) : '') },
  payroll_enabled: { header: 'Payroll Enabled', width: 16, getValue: (e) => (e.payroll_enabled ? 'Yes' : 'No') },
  bank_name: { header: 'Bank Name', width: 20, getValue: (e) => e.bank_name || '' },
  account_number: { header: 'Account Number / IBAN', width: 24, getValue: (e) => e.account_number || '' },

  // Family & Emergency
  father_name: { header: 'Father Name', width: 22, getValue: (e) => e.father_name || '' },
  father_cnic: { header: 'Father CNIC', width: 18, getValue: (e) => e.father_cnic || '' },
  mother_name: { header: 'Mother Name', width: 22, getValue: (e) => e.mother_name || '' },
  mother_cnic: { header: 'Mother CNIC', width: 18, getValue: (e) => e.mother_cnic || '' },
  spouse_name: { header: 'Spouse Name', width: 22, getValue: (e) => e.spouse_name || '' },
  spouse_cnic: { header: 'Spouse CNIC', width: 18, getValue: (e) => e.spouse_cnic || '' },
  emergency_contact_name: { header: 'Emergency Contact Name', width: 24, getValue: (e) => e.emergency_contact_name || '' },
  emergency_contact_phone: { header: 'Emergency Contact Phone', width: 22, getValue: (e) => e.emergency_contact_phone || '' },
  emergency_contact_relationship: {
    header: 'Emergency Contact Relationship',
    width: 24,
    getValue: (e) => e.emergency_contact_relationship || '',
  },

  // System & Administrative
  id: { header: 'DB ID', width: 10, getValue: (e) => e.id },
  employee_code_dep: { header: 'Dept Code Part', width: 14, getValue: (e) => e.employee_code_dep || '' },
  employee_code_number: { header: 'Number Code Part', width: 16, getValue: (e) => e.employee_code_number || '' },
  linked_user: {
    header: 'Linked User Account',
    width: 22,
    getValue: (e) => (e.users ? e.users.username || e.users.email || '' : ''),
  },
  notes: { header: 'Notes / Remarks', width: 30, getValue: (e) => e.notes || '' },
};

export const ALL_EMPLOYEE_COLUMNS = Object.keys(EMPLOYEE_COLUMNS_CONFIG);

export const DEFAULT_EMPLOYEE_COLUMNS = [
  'employee_code',
  'full_name',
  'cnic',
  'campus',
  'department',
  'category',
  'job_title',
  'employment_status',
  'join_date',
  'monthly_pay',
  'personal_phone',
  'personal_email',
];

export async function buildMasterEmployeesExcelBuffer(
  employees: EmployeeProfileForExport[],
  requestedColumns?: string[],
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const isCustom = requestedColumns && requestedColumns.length > 0;
  const sheet = workbook.addWorksheet(isCustom ? 'Employees' : 'Master Employees');

  // Determine columns to export
  const validColumns = isCustom
    ? requestedColumns.filter((col) => EMPLOYEE_COLUMNS_CONFIG[col])
    : ALL_EMPLOYEE_COLUMNS;
  const columnsToExport = validColumns.length > 0 ? validColumns : DEFAULT_EMPLOYEE_COLUMNS;

  // Define worksheet columns
  sheet.columns = columnsToExport.map((colKey) => ({
    header: EMPLOYEE_COLUMNS_CONFIG[colKey].header,
    key: colKey,
    width: EMPLOYEE_COLUMNS_CONFIG[colKey].width,
  }));

  // Style the header row - exactly matches student directory dark blue theme
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1E3A8A' }, // Dark blue theme
  };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
  headerRow.height = 25;

  // Light red background fill for legacy master view rows without active biometric device mapping
  const UNMAPPED_ROW_FILL: ExcelJS.Fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFFEE2E2' },
  };

  for (const emp of employees) {
    const rowData: Record<string, any> = {};
    for (const colKey of columnsToExport) {
      rowData[colKey] = EMPLOYEE_COLUMNS_CONFIG[colKey].getValue(emp);
    }
    const dataRow = sheet.addRow(rowData);
    dataRow.height = 20;

    // Apply unmapped fill on full master exports when device mapping is missing
    if (!isCustom) {
      const activeMapping = getActiveDeviceMapping(emp);
      if (!activeMapping) {
        dataRow.eachCell({ includeEmpty: true }, (cell) => {
          cell.fill = UNMAPPED_ROW_FILL;
        });
      }
    }
  }

  // Auto-fit column widths (exact match with Student Directory)
  sheet.columns.forEach((column) => {
    if (!column || typeof column.eachCell !== 'function') return;
    let maxLen = 0;
    column.eachCell({ includeEmpty: true }, (cell) => {
      const val = cell.value ? String(cell.value) : '';
      if (val.length > maxLen) {
        maxLen = val.length;
      }
    });
    column.width = Math.min(Math.max(maxLen + 4, 10), 45);
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
