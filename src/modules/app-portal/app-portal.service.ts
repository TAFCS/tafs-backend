import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { resolveStudentCalendarDay } from '../hr/calendar/student-calendar-day.util';

@Injectable()
export class AppPortalService {
  constructor(private prisma: PrismaService) {}

  async getStudentLedger(studentCc: number) {
    const student = await this.prisma.students.findUnique({
      where: { cc: studentCc },
      select: {
        cc: true,
        full_name: true,
        gr_number: true,
        photograph_url: true,
        academic_year: true,
        campuses: { select: { campus_name: true } },
        classes: { select: { description: true } },
        sections: { select: { description: true } },
        houses: { select: { house_name: true } },
        dob: true,
        gender: true,
        student_guardians: {
          include: {
            guardians: {
              select: {
                full_name: true,
                primary_phone: true,
              },
            },
          },
        },
      },
    });

    if (!student) {
      throw new NotFoundException(`Student with CC ${studentCc} not found`);
    }

    // Fetch all relevant fees for this student
    const allFees = await this.prisma.student_fees.findMany({
      where: {
        student_id: studentCc,
      },
      include: {
        fee_types: true,
      },
      orderBy: [
        { academic_year: 'desc' },
        { target_month: 'desc' },
      ],
    });

    const outstandingHeads = allFees.filter(fee => {
      const isIssued = fee.status === 'ISSUED';
      const isPartial = fee.status === 'PARTIALLY_PAID';
      const notPaid = fee.status !== 'PAID';
      
      const amount = new Prisma.Decimal(fee.amount ?? 0);
      const paid = new Prisma.Decimal(fee.amount_paid ?? 0);
      const payable = amount.sub(paid);

      return notPaid && (isIssued || isPartial) && payable.gt(0);
    });

    const paidHeads = allFees.filter(fee => fee.status === 'PAID');

    // Grouping helper
    const groupByMonth = (fees: any[]) => {
      const groups = new Map<string, any>();

      for (const fee of fees) {
        const key = `${fee.academic_year}-${fee.target_month}`;
        if (!groups.has(key)) {
          groups.set(key, {
            target_month: fee.target_month,
            academic_year: fee.academic_year,
            monthLabel: this.getMonthLabel(fee.target_month),
            heads: [],
            group_payable: 0,
          });
        }

        const group = groups.get(key);
        const amount = new Prisma.Decimal(fee.amount ?? 0);
        const paid = new Prisma.Decimal(fee.amount_paid ?? 0);
        const payable = amount.sub(paid);

        group.heads.push({
          id: fee.id,
          description: `${fee.description_prefix ? fee.description_prefix + ' — ' : ''}${fee.fee_types.description}`,
          amount: amount.toNumber(),
          amount_paid: paid.toNumber(),
          payable: payable.toNumber(),
          status: fee.status,
          fee_date: fee.fee_date,
          is_issued: fee.status !== 'NOT_ISSUED',
        });

        group.group_payable += payable.toNumber();
      }

      return Array.from(groups.values());
    };

    const outstandingGroups = groupByMonth(outstandingHeads);
    const paidGroups = groupByMonth(paidHeads);

    const totalOutstanding = outstandingHeads.reduce((sum, fee) => {
      const amount = new Prisma.Decimal(fee.amount ?? 0);
      const paid = new Prisma.Decimal(fee.amount_paid ?? 0);
      return sum.add(amount.sub(paid));
    }, new Prisma.Decimal(0));

    const totalPaidThisYear = paidHeads
      .filter(fee => fee.academic_year === student.academic_year)
      .reduce((sum, fee) => sum.add(new Prisma.Decimal(fee.amount_paid ?? 0)), new Prisma.Decimal(0));

    return {
      student: {
        cc: student.cc,
        full_name: student.full_name,
        gr_number: student.gr_number,
        campus: student.campuses?.campus_name,
        class: student.classes?.description,
        section: student.sections?.description,
        house: student.houses?.house_name,
        photograph_url: student.photograph_url,
        dob: student.dob,
        gender: student.gender,
        guardians: student.student_guardians.map(sg => ({
          name: sg.guardians.full_name,
          relationship: sg.relationship,
          phone: sg.guardians.primary_phone,
        })),
      },
      outstanding: outstandingGroups,
      paid: paidGroups,
      summary: {
        total_outstanding: totalOutstanding.toNumber(),
        total_paid_this_year: totalPaidThisYear.toNumber(),
      },
    };
  }

  private getMonthLabel(month: number): string {
    const labels = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];
    return labels[month - 1] || 'Unknown';
  }

  async getStudentAttendanceHistory(studentCc: number, monthStr: string) {
    if (!monthStr || !/^\d{4}-\d{2}$/.test(monthStr)) {
      throw new Error('Invalid month format. Expected YYYY-MM');
    }

    const [year, month] = monthStr.split('-').map(Number);
    const dateFrom = new Date(Date.UTC(year, month - 1, 1));
    const dateTo = new Date(Date.UTC(year, month, 0)); // last day of month

    // Get the student's campus_id
    const student = await this.prisma.students.findUnique({
      where: { cc: studentCc },
      select: { campus_id: true },
    });

    const [scans, records, calendarDays] = await Promise.all([
      this.prisma.zk_attendance_scans.findMany({
        where: {
          student_cc: studentCc,
          person_type: 'STUDENT',
          is_duplicate: false,
          attendance_date: { gte: dateFrom, lte: dateTo },
        },
        orderBy: { scan_time: 'asc' },
      }),
      this.prisma.attendance_student_daily.findMany({
        where: { student_cc: studentCc, date: { gte: dateFrom, lte: dateTo } },
      }),
      student?.campus_id
        ? this.prisma.academic_calendar_days.findMany({
            where: {
              campus_id: student.campus_id,
              date: { gte: dateFrom, lte: dateTo },
              applies_to: 'STUDENT',
            },
          })
        : Promise.resolve([]),
    ]);

    const scansByDate = new Map<string, any[]>();
    for (const scan of scans) {
      const key = scan.attendance_date.toISOString().slice(0, 10);
      const bucket = scansByDate.get(key);
      if (bucket) bucket.push(scan);
      else scansByDate.set(key, [scan]);
    }
    const recordMap = new Map(records.map((r) => [r.date.toISOString().slice(0, 10), r]));
    const holidayMap = new Map<string, any>(
      (calendarDays as any[]).map((c) => [c.date.toISOString().slice(0, 10), c]),
    );

    const days: any[] = [];
    for (let d = new Date(dateFrom); d <= dateTo; d.setUTCDate(d.getUTCDate() + 1)) {
      const key = d.toISOString().slice(0, 10);
      const record = recordMap.get(key) ?? null;
      const dayScans = scansByDate.get(key) ?? [];
      const calDay = holidayMap.get(key) ?? null;

      const sessions: any[] = [];
      for (let i = 0; i + 1 < dayScans.length; i += 2) {
        sessions.push({
          clock_in: dayScans[i].scan_time,
          clock_out: dayScans[i + 1].scan_time,
        });
      }
      if (dayScans.length % 2 !== 0) {
        sessions.push({
          clock_in: dayScans[dayScans.length - 1].scan_time,
          clock_out: null,
        });
      }

      const { holiday_type, holiday_description } = resolveStudentCalendarDay(
        new Date(d),
        calDay,
      );

      days.push({
        date: key,
        status: record?.status ?? null, // e.g. PRESENT, ABSENT, etc.
        sessions,
        holiday_type,
        holiday_description,
      });
    }

    return {
      student_cc: studentCc,
      month: monthStr,
      days,
    };
  }
}
