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
  is_permanent_employee: boolean | null;
  job_title: string | null;
  job_description: string | null;
  monthly_pay: any;
  reporting_time: Date | string | null;
  leaving_time: Date | string | null;
  days_per_week: number | null;
  late_relaxation_minutes: number | null;
  check_in_source: string | null;
  bank_name: string | null;
  account_number: string | null;
  address: string | null;
  personal_phone: string | null;
  personal_email: string | null;
  father_name: string | null;
  mother_name: string | null;
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
  designations?: { title: string } | null;
  staff_types?: { name: string } | null;
  reporting_manager?: { full_name: string | null } | null;
  users?: { username: string; email: string | null } | null;
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

export async function buildMasterEmployeesExcelBuffer(employees: EmployeeProfileForExport[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Master Employees');

  const headers = [
    'DB ID',
    'Employee Code',
    'Dept Code Part',
    'Number Code Part',
    'Full Name',
    'CNIC',
    'Date of Birth',
    'Campus Name',
    'Department',
    'Subcategory',
    'Designation',
    'Staff Type',
    'Job Title',
    'Job Description',
    'Class-Section Assignments',
    'Employment Status',
    'Is Permanent?',
    'Date of Joining',
    'Reporting Manager',
    'Reporting Time',
    'Leaving Time',
    'Days Per Week',
    'Late Relaxation (Mins)',
    'Check-In Source',
    'Biometric Device PIN',
    'Biometric Device SN',
    'Monthly Pay (PKR)',
    'Bank Name',
    'Account Number / IBAN',
    'Address',
    'Personal Phone',
    'Personal Email',
    'Father Name',
    'Mother Name',
    'Spouse Name',
    'Spouse CNIC',
    'Emergency Contact Name',
    'Emergency Contact Phone',
    'Emergency Contact Relationship',
    'Linked User Account',
    'Photo URL',
    'Notes / Remarks'
  ];

  const headerRow = sheet.addRow(headers);
  headerRow.height = 24;
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFF' }, size: 10, name: 'Calibri' };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });

  // Light red background fill for rows without active biometric device mapping
  const UNMAPPED_ROW_FILL: ExcelJS.Fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFFEE2E2' }, // Light red (Tailwind red-100 equivalent)
  };

  for (const emp of employees) {
    // Format class-section assignments
    const assignmentsMap: Record<string, string[]> = {};
    if (emp.employee_class_section_assignments) {
      for (const a of emp.employee_class_section_assignments) {
        const className = a.classes ? (a.classes.description || a.classes.class_code || 'Class') : 'Class';
        const secName = a.sections ? a.sections.description : '';
        if (!assignmentsMap[className]) assignmentsMap[className] = [];
        if (secName) assignmentsMap[className].push(secName);
      }
    }
    const assignmentsFormatted = Object.entries(assignmentsMap)
      .map(([cls, secs]) => `${cls}${secs.length ? `: ${secs.join(', ')}` : ''}`)
      .join('; ');

    // Active biometric device mapping
    const activeMappings = (emp.device_user_mappings || []).filter(m => m.is_active !== false);
    const hasDeviceMapping = activeMappings.length > 0;
    const activeMapping = hasDeviceMapping ? activeMappings[0] : null;

    const devicePin = activeMapping ? activeMapping.device_pin : '';
    const deviceSn = activeMapping ? activeMapping.device_sn : '';

    const rowValues = [
      emp.id,
      emp.employee_code || '',
      emp.employee_code_dep || '',
      emp.employee_code_number || '',
      emp.full_name || '',
      emp.cnic || '',
      formatDate(emp.date_of_birth),
      emp.campuses ? emp.campuses.campus_name : '',
      emp.departments ? emp.departments.name : '',
      emp.staff_categories ? emp.staff_categories.name : '',
      emp.designations ? emp.designations.title : '',
      emp.staff_types ? emp.staff_types.name : '',
      emp.job_title || '',
      emp.job_description || '',
      assignmentsFormatted,
      emp.employment_status || 'ACTIVE',
      emp.is_permanent_employee ? 'Yes' : 'No',
      formatDate(emp.join_date),
      emp.reporting_manager ? emp.reporting_manager.full_name : '',
      formatTime(emp.reporting_time),
      formatTime(emp.leaving_time),
      emp.days_per_week !== null && emp.days_per_week !== undefined ? emp.days_per_week : '',
      emp.late_relaxation_minutes !== null && emp.late_relaxation_minutes !== undefined ? emp.late_relaxation_minutes : '',
      emp.check_in_source || '',
      devicePin,
      deviceSn,
      emp.monthly_pay ? Number(emp.monthly_pay) : '',
      emp.bank_name || '',
      emp.account_number || '',
      emp.address || '',
      emp.personal_phone || '',
      emp.personal_email || '',
      emp.father_name || '',
      emp.mother_name || '',
      emp.spouse_name || '',
      emp.spouse_cnic || '',
      emp.emergency_contact_name || '',
      emp.emergency_contact_phone || '',
      emp.emergency_contact_relationship || '',
      emp.users ? (emp.users.username || emp.users.email || '') : '',
      emp.photo_url || '',
      emp.notes || ''
    ];

    const dataRow = sheet.addRow(rowValues);
    dataRow.height = 20;

    if (!hasDeviceMapping) {
      dataRow.eachCell({ includeEmpty: true }, (cell) => {
        cell.fill = UNMAPPED_ROW_FILL;
      });
    }
  }

  // Set auto column widths
  sheet.columns.forEach((col, i) => {
    const headerLen = headers[i] ? headers[i].length : 10;
    col.width = Math.min(Math.max(headerLen + 4, 12), 45);
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
