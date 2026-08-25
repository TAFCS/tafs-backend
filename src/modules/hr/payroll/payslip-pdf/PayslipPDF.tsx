import React from 'react';
import { Page, Text, View, Document, StyleSheet, Image } from '@react-pdf/renderer';
import path from 'path';
import fs from 'fs';

// Same source asset + branding as the fee voucher challan (FeeChallanPDF.tsx)
// so the payslip reads as the same family of document.
const LOGO_PATH = path.join(process.cwd(), 'src', 'assets', 'logo.png');
const LOGO_BUFFER = fs.readFileSync(LOGO_PATH);

const OVERTIME_RATE_LABELS: Record<string, string> = {
  PER_MINUTE: 'per minute',
  PER_HOUR: 'per hour',
  PER_DAY: 'per day',
};

function money(value: number): string {
  return `Rs. ${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatMinutes(minutes: number): string {
  const m = Math.round(minutes);
  if (m <= 0) return '0m';
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return h > 0 ? (rm > 0 ? `${h}h ${rm}m` : `${h}h`) : `${rm}m`;
}

const styles = StyleSheet.create({
  page: {
    backgroundColor: '#ffffff',
    padding: 28,
    fontSize: 9,
    fontFamily: 'Helvetica',
    color: '#1a1a1a',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#333333',
  },
  logo: { width: 44, height: 44, marginRight: 12 },
  schoolName: { fontSize: 14, fontWeight: 'bold', color: '#1a1a1a', letterSpacing: 0.3 },
  schoolSub: { fontSize: 8, color: '#333333', marginTop: 2 },
  docTitle: {
    marginLeft: 'auto',
    textAlign: 'right',
  },
  docTitleText: { fontSize: 12, fontWeight: 'bold', color: '#1a1a1a', textTransform: 'uppercase' },
  docSubText: { fontSize: 7.5, color: '#555555', marginTop: 2 },
  infoSection: {
    flexDirection: 'row',
    backgroundColor: '#f9f9f9',
    borderWidth: 0.5,
    borderColor: '#cbd5e1',
    borderRadius: 4,
    padding: 8,
    marginBottom: 14,
  },
  infoCol: { flex: 1 },
  infoLabel: { fontSize: 6, textTransform: 'uppercase', color: '#333333', fontWeight: 'bold', marginBottom: 1 },
  infoValue: { fontSize: 9.5, fontWeight: 'bold', color: '#1a1a1a', marginBottom: 6 },
  sectionLabelRow: {
    backgroundColor: '#f8fafc',
    paddingVertical: 3,
    paddingHorizontal: 4,
    marginBottom: 4,
    borderLeftWidth: 2.5,
    borderLeftColor: '#94a3b8',
  },
  sectionLabel: { fontSize: 7.5, fontWeight: 'bold', color: '#334155', textTransform: 'uppercase', letterSpacing: 0.5 },
  table: { marginBottom: 12 },
  tableHeader: {
    flexDirection: 'row',
    borderBottomWidth: 0.75,
    borderBottomColor: '#333333',
    paddingBottom: 3,
    marginBottom: 3,
  },
  tableHeaderText: { fontSize: 7, fontWeight: 'bold', color: '#333333', textTransform: 'uppercase' },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 3,
    borderBottomWidth: 0.3,
    borderBottomColor: '#e5e7eb',
  },
  colLabel: { flex: 3, fontSize: 9 },
  colValue: { flex: 1.4, textAlign: 'right', fontSize: 9 },
  totalRow: {
    flexDirection: 'row',
    marginTop: 3,
    paddingVertical: 5,
    borderTopWidth: 1,
    borderTopColor: '#333333',
  },
  totalLabel: { flex: 3, fontSize: 10, fontWeight: 'bold' },
  totalValue: { flex: 1.4, textAlign: 'right', fontSize: 10, fontWeight: 'bold' },
  deductionValue: { flex: 1.4, textAlign: 'right', fontSize: 9, color: '#b91c1c' },
  overtimeBox: {
    backgroundColor: '#fffbeb',
    borderWidth: 0.5,
    borderColor: '#f59e0b',
    borderRadius: 4,
    padding: 8,
    marginBottom: 12,
  },
  overtimeTitle: { fontSize: 8, fontWeight: 'bold', color: '#b45309', textTransform: 'uppercase', marginBottom: 3 },
  overtimeRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 1 },
  overtimeLabel: { fontSize: 8.5, color: '#78350f' },
  overtimeValue: { fontSize: 8.5, fontWeight: 'bold', color: '#78350f' },
  netPaidBox: {
    backgroundColor: '#f0fdf4',
    borderWidth: 0.75,
    borderColor: '#16a34a',
    borderRadius: 4,
    padding: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 4,
  },
  netPaidLabel: { fontSize: 11, fontWeight: 'bold', color: '#14532d', textTransform: 'uppercase' },
  netPaidValue: { fontSize: 15, fontWeight: 'bold', color: '#14532d' },
  footer: {
    marginTop: 'auto',
    paddingTop: 10,
    borderTopWidth: 0.5,
    borderTopColor: '#efefef',
  },
  footerText: { fontSize: 6.5, color: '#555555', textAlign: 'center' },
  footerNote: { fontSize: 6, color: '#94a3b8', textAlign: 'center', marginTop: 2 },
});

export interface PayslipPDFProps {
  employee: {
    fullName: string;
    employeeCode: string | null;
    jobTitle: string | null;
    campusName: string;
  };
  period: { start: string; end: string };
  attendance: {
    scheduledWorkingDays: number;
    presentDays: number;
    lateDays: number;
    halfDays: number;
    absentDays: number;
    excusedDays: number;
    unpaidLeaveDays: number;
    totalBreakMinutes: number;
    totalLateMinutes: number;
  };
  pay: {
    monthlyPay: number;
    dailyRate: number;
    absenceDeduction: number;
    halfDayDeduction: number;
    lateDeduction: number;
    breakDeduction: number;
    sandwichDeduction: number;
    consecutiveLateDeduction: number;
    eobiDeduction: number;
    incomeTaxDeduction: number;
    securityDepositDeduction: number;
    loanDeduction: number;
    totalDeductions: number;
    netPay: number;
  };
  /** Omitted entirely when no overtime reward was given for this period. */
  overtime?: {
    rateType: 'PER_MINUTE' | 'PER_HOUR' | 'PER_DAY';
    rateAmount: number;
    overtimeMinutes: number;
    overtimeDays: number;
    rewardAmount: number;
  };
  /** monthly net pay + overtime reward. Cash bonus is intentionally never a prop of this component. */
  netPaid: number;
  settledAt: string;
  generatedByName?: string;
}

export const PayslipPDF = ({ employee, period, attendance, pay, overtime, netPaid, settledAt, generatedByName }: PayslipPDFProps) => (
  <Document>
    <Page size="A4" style={styles.page}>
      <View style={styles.header}>
        <Image src={{ data: LOGO_BUFFER, format: 'png' }} style={styles.logo} />
        <View>
          <Text style={styles.schoolName}>THE AMERICAN FOUNDATION SCHOOL</Text>
          <Text style={styles.schoolSub}>{employee.campusName}</Text>
        </View>
        <View style={styles.docTitle}>
          <Text style={styles.docTitleText}>Payslip</Text>
          <Text style={styles.docSubText}>{period.start} – {period.end}</Text>
        </View>
      </View>

      <View style={styles.infoSection}>
        <View style={styles.infoCol}>
          <Text style={styles.infoLabel}>Employee</Text>
          <Text style={styles.infoValue}>{employee.fullName}</Text>
          <Text style={styles.infoLabel}>Employee Code</Text>
          <Text style={styles.infoValue}>{employee.employeeCode ?? '—'}</Text>
        </View>
        <View style={styles.infoCol}>
          <Text style={styles.infoLabel}>Job Title</Text>
          <Text style={styles.infoValue}>{employee.jobTitle ?? '—'}</Text>
          <Text style={styles.infoLabel}>Settled On</Text>
          <Text style={styles.infoValue}>{settledAt}</Text>
        </View>
      </View>

      <View style={styles.sectionLabelRow}>
        <Text style={styles.sectionLabel}>Attendance Summary</Text>
      </View>
      <View style={styles.table}>
        <View style={styles.tableHeader}>
          <Text style={[styles.tableHeaderText, { flex: 3 }]}>Item</Text>
          <Text style={[styles.tableHeaderText, { flex: 1.4, textAlign: 'right' }]}>Count</Text>
        </View>
        <View style={styles.tableRow}>
          <Text style={styles.colLabel}>Scheduled Working Days</Text>
          <Text style={styles.colValue}>{attendance.scheduledWorkingDays}</Text>
        </View>
        <View style={styles.tableRow}>
          <Text style={styles.colLabel}>Present Days (incl. late)</Text>
          <Text style={styles.colValue}>{attendance.presentDays}</Text>
        </View>
        <View style={styles.tableRow}>
          <Text style={styles.colLabel}>Late Days ({attendance.totalLateMinutes}m total)</Text>
          <Text style={styles.colValue}>{attendance.lateDays}</Text>
        </View>
        <View style={styles.tableRow}>
          <Text style={styles.colLabel}>Half Days</Text>
          <Text style={styles.colValue}>{attendance.halfDays}</Text>
        </View>
        <View style={styles.tableRow}>
          <Text style={styles.colLabel}>Absent Days</Text>
          <Text style={styles.colValue}>{attendance.absentDays}</Text>
        </View>
        <View style={styles.tableRow}>
          <Text style={styles.colLabel}>Excused / Leave Days</Text>
          <Text style={styles.colValue}>{attendance.excusedDays}</Text>
        </View>
        <View style={styles.tableRow}>
          <Text style={styles.colLabel}>Unpaid Leave Days</Text>
          <Text style={styles.colValue}>{attendance.unpaidLeaveDays}</Text>
        </View>
        <View style={styles.tableRow}>
          <Text style={styles.colLabel}>Total Break Time</Text>
          <Text style={styles.colValue}>{formatMinutes(attendance.totalBreakMinutes)}</Text>
        </View>
      </View>

      <View style={styles.sectionLabelRow}>
        <Text style={styles.sectionLabel}>Pay Breakdown</Text>
      </View>
      <View style={styles.table}>
        <View style={styles.tableRow}>
          <Text style={styles.colLabel}>Monthly Pay Rate</Text>
          <Text style={styles.colValue}>{money(pay.monthlyPay)}</Text>
        </View>
        <View style={styles.tableRow}>
          <Text style={styles.colLabel}>Daily Rate</Text>
          <Text style={styles.colValue}>{money(pay.dailyRate)}</Text>
        </View>
        {pay.absenceDeduction > 0 && (
          <View style={styles.tableRow}>
            <Text style={styles.colLabel}>Absence Deduction (days marked absent or unpaid leave)</Text>
            <Text style={styles.deductionValue}>-{money(pay.absenceDeduction)}</Text>
          </View>
        )}
        {pay.halfDayDeduction > 0 && (
          <View style={styles.tableRow}>
            <Text style={styles.colLabel}>Half Day Deduction (half-day attendance)</Text>
            <Text style={styles.deductionValue}>-{money(pay.halfDayDeduction)}</Text>
          </View>
        )}
        {pay.lateDeduction > 0 && (
          <View style={styles.tableRow}>
            <Text style={styles.colLabel}>Late Deduction (minutes arrived after grace period)</Text>
            <Text style={styles.deductionValue}>-{money(pay.lateDeduction)}</Text>
          </View>
        )}
        {pay.breakDeduction > 0 && (
          <View style={styles.tableRow}>
            <Text style={styles.colLabel}>Break Deduction (time spent on breaks beyond work hours)</Text>
            <Text style={styles.deductionValue}>-{money(pay.breakDeduction)}</Text>
          </View>
        )}
        {pay.sandwichDeduction > 0 && (
          <View style={styles.tableRow}>
            <Text style={styles.colLabel}>Off-Day Deduction (absent the working day before &amp; after this break)</Text>
            <Text style={styles.deductionValue}>-{money(pay.sandwichDeduction)}</Text>
          </View>
        )}
        {pay.consecutiveLateDeduction > 0 && (
          <View style={styles.tableRow}>
            <Text style={styles.colLabel}>Late Attendance Deduction (3 consecutive late days = 1 day's pay)</Text>
            <Text style={styles.deductionValue}>-{money(pay.consecutiveLateDeduction)}</Text>
          </View>
        )}
        {pay.eobiDeduction > 0 && (
          <View style={styles.tableRow}>
            <Text style={styles.colLabel}>EOBI Contribution</Text>
            <Text style={styles.deductionValue}>-{money(pay.eobiDeduction)}</Text>
          </View>
        )}
        {pay.incomeTaxDeduction > 0 && (
          <View style={styles.tableRow}>
            <Text style={styles.colLabel}>Income Tax</Text>
            <Text style={styles.deductionValue}>-{money(pay.incomeTaxDeduction)}</Text>
          </View>
        )}
        {pay.loanDeduction > 0 && (
          <View style={styles.tableRow}>
            <Text style={styles.colLabel}>Loan</Text>
            <Text style={styles.deductionValue}>-{money(pay.loanDeduction)}</Text>
          </View>
        )}
        {pay.securityDepositDeduction > 0 && (
          <View style={styles.tableRow}>
            <Text style={styles.colLabel}>Security Deposit</Text>
            <Text style={styles.deductionValue}>-{money(pay.securityDepositDeduction)}</Text>
          </View>
        )}
        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>Net Pay (before overtime)</Text>
          <Text style={styles.totalValue}>{money(pay.netPay)}</Text>
        </View>
      </View>

      {overtime && overtime.rewardAmount > 0 && (
        <View style={styles.overtimeBox}>
          <Text style={styles.overtimeTitle}>Overtime Reward</Text>
          <View style={styles.overtimeRow}>
            <Text style={styles.overtimeLabel}>Total overtime worked this period</Text>
            <Text style={styles.overtimeValue}>{formatMinutes(overtime.overtimeMinutes)}</Text>
          </View>
          {overtime.rateType === 'PER_DAY' && (
            <View style={styles.overtimeRow}>
              <Text style={styles.overtimeLabel}>Days worked overtime</Text>
              <Text style={styles.overtimeValue}>{overtime.overtimeDays}</Text>
            </View>
          )}
          <View style={styles.overtimeRow}>
            <Text style={styles.overtimeLabel}>Rate ({OVERTIME_RATE_LABELS[overtime.rateType] ?? overtime.rateType})</Text>
            <Text style={styles.overtimeValue}>{money(overtime.rateAmount)}</Text>
          </View>
          <View style={styles.overtimeRow}>
            <Text style={styles.overtimeLabel}>Overtime Reward Amount</Text>
            <Text style={styles.overtimeValue}>{money(overtime.rewardAmount)}</Text>
          </View>
        </View>
      )}

      <View style={styles.netPaidBox}>
        <Text style={styles.netPaidLabel}>Total Net Paid</Text>
        <Text style={styles.netPaidValue}>{money(netPaid)}</Text>
      </View>

      <View style={styles.footer}>
        <Text style={styles.footerText}>
          Generated by {generatedByName || 'TAFSync System'} on {settledAt}
        </Text>
        <Text style={styles.footerNote}>
          {pay.incomeTaxDeduction > 0
            ? 'This payslip reflects attendance-based pay and statutory deductions for the stated period.'
            : 'This payslip reflects attendance-based pay for the stated period. No tax has been deducted.'}
        </Text>
      </View>
    </Page>
  </Document>
);
