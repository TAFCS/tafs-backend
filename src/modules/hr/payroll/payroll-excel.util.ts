import ExcelJS from 'exceljs';
import { DayBreakdownEntry } from './payroll.service';
import { CycleTenure, OffRollReason, offRollReason } from './tenure-window.util';

type DayClassification = DayBreakdownEntry['classification'];

export interface ExportableAttendanceLine {
  employee_id: number;
  campus_name?: string;
  employee_profiles?: { full_name: string | null; employee_code: string | null } | null;
  has_salary: boolean;
  is_mapped: boolean;
  has_punches: boolean;
  daily_breakdown: DayBreakdownEntry[];
  /** Attendance-matrix lines only; payroll-run lines carry no tenure. */
  tenure?: CycleTenure;
}

export interface EmployeeLineColumn<T> {
  header: string;
  width: number;
  getValue: (line: T) => string | number;
}

const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };

// Approximates the Tailwind bg-*-50/100 fills used by CELL_BG in
// PayrollMatrixView.tsx — same palette, so the export visually matches the
// webpage's punch card matrix.
const CELL_FILL: Record<DayClassification, string | null> = {
  PRESENT: null,
  LATE: 'FFFFFBEB',
  HALF_DAY: 'FFFFF7ED',
  ABSENT: 'FFFFF1F2',
  EXCUSED: 'FFF0F9FF',
  SICK_LEAVE: 'FFF5F3FF',
  CASUAL_LEAVE: 'FFF0FDFA',
  ANNUAL_LEAVE: 'FFEEF2FF',
  UNPAID_LEAVE: 'FFFFE4E6',
  UNRESOLVED: 'FFFEF3C7',
  DAY_OFF: 'FFFAFAFA',
};

const LEGEND: [DayClassification, string][] = [
  ['PRESENT', 'Present'],
  ['LATE', 'Late'],
  ['HALF_DAY', 'Half Day'],
  ['ABSENT', 'Absent'],
  ['EXCUSED', 'Excused'],
  ['SICK_LEAVE', 'Sick Leave'],
  ['CASUAL_LEAVE', 'Casual Leave'],
  ['ANNUAL_LEAVE', 'Annual Leave'],
  ['UNPAID_LEAVE', 'Unpaid Leave'],
  ['UNRESOLVED', 'Unresolved'],
  ['DAY_OFF', 'Day Off'],
];

const OFF_ROLL_TEXT: Record<OffRollReason, string> = {
  BEFORE_JOIN: 'Not joined',
  AFTER_LEAVE: 'Left',
  BETWEEN_TENURES: 'Off roll',
};
// Diagonal grey hatch: reads as "not applicable" rather than any attendance state.
const OFF_ROLL_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'lightUp', fgColor: { argb: 'FFD4D4D8' }, bgColor: { argb: 'FFF4F4F5' } };

function fmtDate(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** "Joined 12 Oct 2026 · Left 20 Oct 2026 (9 of 31 days)" — empty for a full-cycle employee. */
export function tenureLabel(tenure: CycleTenure | undefined): string {
  if (!tenure) return '';
  const parts: string[] = [];
  if (tenure.rejoined) parts.push(`Rejoined ${fmtDate(tenure.windows[tenure.windows.length - 1].start)}`);
  else if (tenure.joined_on) parts.push(`Joined ${fmtDate(tenure.joined_on)}`);
  if (tenure.left_on) parts.push(`Left ${fmtDate(tenure.left_on)}`);
  if (parts.length === 0) return '';
  return `${parts.join(' · ')} (${tenure.in_tenure_days} of ${tenure.period_days} days)`;
}

export function tagLabels(line: { has_salary: boolean; is_mapped: boolean; has_punches: boolean }): string {
  const tags: string[] = [];
  if (!line.has_salary) tags.push('No Salary');
  if (!line.is_mapped) tags.push('Not Mapped');
  else if (!line.has_punches) tags.push('No Punches');
  return tags.join(', ');
}

function fmtTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

function dayCellText(day: DayBreakdownEntry): string {
  const cls = day.classification;
  if (cls === 'DAY_OFF' || !day.is_working_day) return day.day_description ?? 'Off';
  if (cls === 'ABSENT') return 'Absent';
  if (cls === 'EXCUSED') return 'Excused';
  if (cls === 'SICK_LEAVE') return 'Sick';
  if (cls === 'CASUAL_LEAVE') return 'Casual';
  if (cls === 'ANNUAL_LEAVE') return 'Annual';
  if (cls === 'UNPAID_LEAVE') return 'Unpaid';
  if (cls === 'UNRESOLVED') return day.check_in_at ? `${fmtTime(day.check_in_at)} - ?` : 'Unresolved';

  const inOut = day.check_in_at
    ? `${fmtTime(day.check_in_at)}${day.check_out_at ? ' - ' + fmtTime(day.check_out_at) : ''}`
    : 'No data';
  return cls === 'LATE' && day.late_minutes > 0 ? `${inOut} (+${day.late_minutes}m)` : inOut;
}

function generateDates(periodStart: string, periodEnd: string): string[] {
  const dates: string[] = [];
  const d = new Date(`${periodStart.slice(0, 10)}T00:00:00Z`);
  const e = new Date(`${periodEnd.slice(0, 10)}T00:00:00Z`);
  while (d <= e) {
    dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return dates;
}

export function addEmployeeLinesSheet<T extends ExportableAttendanceLine>(
  workbook: ExcelJS.Workbook,
  lines: T[],
  columns: EmployeeLineColumn<T>[],
) {
  const sheet = workbook.addWorksheet('Employee Lines');
  sheet.columns = columns.map((c) => ({ header: c.header, width: c.width }));

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = HEADER_FILL;
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
  headerRow.height = 22;

  for (const line of lines) {
    sheet.addRow(columns.map((c) => c.getValue(line)));
  }
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

export function addMatrixSheet(
  workbook: ExcelJS.Workbook,
  lines: ExportableAttendanceLine[],
  periodStart: string,
  periodEnd: string,
  includeCampusColumn: boolean,
) {
  const sheet = workbook.addWorksheet('Punch Card Matrix');
  const dates = generateDates(periodStart, periodEnd);
  const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

  const baseCols = [
    { header: 'Employee', width: 26 },
    { header: 'Code', width: 14 },
    ...(includeCampusColumn ? [{ header: 'Campus', width: 20 }] : []),
  ];
  const dateCols = dates.map((d) => {
    const dt = new Date(`${d}T00:00:00Z`);
    return { header: `${DAYS[dt.getUTCDay()]} ${dt.getUTCDate()}`, width: 14 };
  });
  sheet.columns = [...baseCols, ...dateCols];

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = HEADER_FILL;
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
  headerRow.height = 22;

  const dateColOffset = baseCols.length;
  for (const line of lines) {
    const emp = line.employee_profiles;
    const dayMap = new Map(line.daily_breakdown.map((d) => [d.date, d]));

    const row = sheet.addRow([
      emp?.full_name ?? `Employee #${line.employee_id}`,
      emp?.employee_code ?? '',
      ...(includeCampusColumn ? [line.campus_name ?? ''] : []),
      ...dates.map((d) => {
        const day = dayMap.get(d);
        if (day) return dayCellText(day);
        const reason = line.tenure ? offRollReason(d, line.tenure) : null;
        return reason ? OFF_ROLL_TEXT[reason] : '';
      }),
    ]);
    row.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    row.getCell(1).alignment = { vertical: 'middle', horizontal: 'left' };

    dates.forEach((d, i) => {
      const day = dayMap.get(d);
      const cell = row.getCell(dateColOffset + i + 1);
      if (!day && line.tenure && offRollReason(d, line.tenure)) {
        cell.fill = OFF_ROLL_FILL;
        cell.font = { color: { argb: 'FFA1A1AA' }, italic: true };
        return;
      }
      const fill = day ? CELL_FILL[day.classification] : null;
      if (fill) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      }
    });
  }
  sheet.views = [{ state: 'frozen', xSplit: dateColOffset, ySplit: 1 }];

  // Legend
  const legendStartRow = lines.length + 3;
  sheet.getCell(legendStartRow, 1).value = 'Legend';
  sheet.getCell(legendStartRow, 1).font = { bold: true };
  LEGEND.forEach(([cls, label], i) => {
    const cell = sheet.getCell(legendStartRow + 1 + i, 1);
    cell.value = label;
    const fill = CELL_FILL[cls];
    if (fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
  });
  if (lines.some((l) => l.tenure)) {
    const cell = sheet.getCell(legendStartRow + 1 + LEGEND.length, 1);
    cell.value = 'Not on roll (before joining / after leaving) — not counted, as in payroll';
    cell.fill = OFF_ROLL_FILL;
  }
}
