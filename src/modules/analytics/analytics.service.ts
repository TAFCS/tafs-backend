import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class AnalyticsService {
  constructor(private prisma: PrismaService) {}

  private getCurrentAcademicYear(): string {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth(); 
    const startYear = currentMonth >= 7 ? currentYear : currentYear - 1;
    return `${startYear}-${startYear + 1}`;
  }

  async getDashboardStats(campusId?: number) {
    const currentYear = this.getCurrentAcademicYear();

    const studentFilter: any = {
      status: 'ENROLLED',
      ...(campusId ? { campus_id: campusId } : {}),
      deleted_at: null,
    };

    const feeFilter: any = {
      students: studentFilter,
    };

    // 1. Current Year Financials
    const collectionStats = await this.prisma.student_fees.aggregate({
      where: {
        academic_year: currentYear,
        ...feeFilter,
      },
      _sum: {
        amount: true,
        amount_paid: true,
      },
    });

    const expected = Number(collectionStats._sum?.amount || 0);
    const collected = Number(collectionStats._sum?.amount_paid || 0);
    const outstanding = expected - collected;
    const collectionRate = expected > 0 ? (collected / expected) * 100 : 0;

    // 2. Arrears (Previous Years)
    // Filter for fees NOT in the current academic year that are unpaid
    const arrearsStats = await this.prisma.student_fees.aggregate({
      where: {
        academic_year: { not: currentYear },
        status: { not: 'PAID' },
        ...feeFilter,
      },
      _sum: {
        amount: true,
        amount_paid: true,
      },
    });

    const arrearsAmount = Number(arrearsStats._sum?.amount || 0) - Number(arrearsStats._sum?.amount_paid || 0);

    // 3. Student Strength
    const totalStudents = await this.prisma.students.count({
      where: studentFilter,
    });

    const branchCounts = await this.prisma.students.groupBy({
      by: ['campus_id'],
      where: { status: 'ENROLLED', deleted_at: null }, 
      _count: {
        cc: true,
      },
    });

    // Resolve campus names and list
    const campusesList = await this.prisma.campuses.findMany({
        select: { id: true, campus_name: true },
        orderBy: { campus_name: 'asc' }
    });
    const campusMap = new Map(campusesList.map((c) => [c.id, c.campus_name]));

    const branchwiseStrength = branchCounts.map((b) => ({
      campus_id: b.campus_id,
      campus_name: campusMap.get(b.campus_id || 0) || 'Unknown',
      count: b._count.cc,
    }));

    // 4. Monthly Trends (August to July)
    // The user wants: "total of all the heads in that month through fee_date and thier amounts then compare them too amount_paid"
    const startYear = parseInt(currentYear.split('-')[0]);
    const monthNames = ["Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul"];
    
    const trends = await Promise.all(monthNames.map(async (name, i) => {
      // August is month 7 (0-indexed) in JS Date
      // Sequence: 7, 8, 9, 10, 11 (2025) then 0, 1, 2, 3, 4, 5, 6 (2026)
      const jsMonth = (i + 7) % 12;
      const year = (i + 7) >= 12 ? startYear + 1 : startYear;
      
      const startDate = new Date(year, jsMonth, 1);
      const endDate = new Date(year, jsMonth + 1, 0, 23, 59, 59);

      const stats = await this.prisma.student_fees.aggregate({
        where: {
          fee_date: {
            gte: startDate,
            lte: endDate
          },
          ...feeFilter
        },
        _sum: {
          amount: true,
          amount_paid: true
        }
      });

      const exp = Number(stats._sum?.amount || 0);
      const coll = Number(stats._sum?.amount_paid || 0);

      return {
        month: name,
        collected: coll,
        expected: exp,
        shortfall: Math.max(0, exp - coll)
      };
    }));

    return {
      financials: {
        currentYear,
        expected,
        collected,
        outstanding,
        collectionRate,
        arrears: arrearsAmount,
      },
      students: {
        total: totalStudents,
        branchwise: branchwiseStrength,
      },
      campuses: campusesList,
      trends
    };
  }
}
