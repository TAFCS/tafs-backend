import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { EnrollStudentDto } from './dto/enroll-student.dto';
import { student_status } from '@prisma/client';

@Injectable()
export class EnrollmentService {
  constructor(private readonly prisma: PrismaService) {}

  async getCandidates() {
    return this.prisma.students.findMany({
      where: {
        status: 'SOFT_ADMISSION',
        deleted_at: null,
      },
      include: {
        campuses: { select: { campus_name: true, campus_code: true } },
        classes: { select: { description: true, class_code: true } },
        sections: { select: { description: true } },
        student_admissions: {
            orderBy: { application_date: 'desc' },
            take: 1
        }
      },
      orderBy: { created_at: 'desc' },
    });
  }

  async getSuggestions(cc: number) {
    const student = await this.prisma.students.findUnique({
      where: { cc },
      select: { campus_id: true, class_id: true, status: true },
    });

    if (!student || student.status !== 'SOFT_ADMISSION') {
      throw new NotFoundException(`Valid candidate with CC #${cc} not found`);
    }

    const [suggested_gr, suggested_house, suggested_section] = await Promise.all([
      this.computeNextGr(student.campus_id),
      this.computeBalancedHouse(student.class_id),
      this.computeBalancedSection(student.campus_id, student.class_id),
    ]);

    // Fetch all houses for selection
    const all_houses = await this.prisma.houses.findMany();
    // Fetch all sections only if both campus and class are known
    let available_sections: any[] = [];
    if (student.campus_id && student.class_id) {
        const campus_sections = await this.prisma.campus_sections.findMany({
            where: {
                campus_id: student.campus_id,
                class_id: student.class_id,
                is_active: true
            },
            include: {
                sections: true
            }
        });
        // Ensure uniqueness just in case
        const seen = new Set();
        available_sections = campus_sections
            .map(cs => cs.sections)
            .filter(s => {
                if (!s || seen.has(s.id)) return false;
                seen.add(s.id);
                return true;
            });
    }

    return {
      suggested_gr,
      suggested_house,
      suggested_section,
      all_houses,
      available_sections
    };
  }

  async enroll(cc: number, dto: EnrollStudentDto) {
    const student = await this.prisma.students.findUnique({
      where: { cc },
    });

    if (!student || student.status !== 'SOFT_ADMISSION') {
      throw new BadRequestException(`Student #${cc} is not eligible for enrollment`);
    }

    return this.prisma.students.update({
      where: { cc },
      data: {
        status: 'ENROLLED',
        gr_number: dto.gr_number,
        house_id: dto.house_id,
        section_id: dto.section_id || undefined,
        doa: new Date(), // Date of Admission
      },
      include: {
        campuses: true,
        classes: true,
        sections: true,
        houses: true,
      }
    });
  }

  private async computeNextGr(campusId: number | null): Promise<string> {
    if (!campusId) return '1';

    // Optimize: Instead of fetching ALL students, fetch the most recent ones 
    // to determine the current GR sequence and prefix.
    const students = await this.prisma.students.findMany({
      where: { campus_id: campusId, gr_number: { not: null } },
      select: { gr_number: true },
      orderBy: { cc: 'desc' },
      take: 500, // Look at the last 500 admissions to find the max GR
    });

    if (students.length === 0) return '1';

    let maxNum = 0;
    let mainPrefix = '';

    for (const s of students) {
      if (!s.gr_number) continue;
      
      // Match pattern like "ABC-123" or just "123"
      const match = s.gr_number.match(/^(.*?)([0-9]+)$/);
      if (match) {
        const prefix = match[1];
        const num = parseInt(match[2], 10);
        if (num > maxNum) {
          maxNum = num;
          mainPrefix = prefix;
        }
      } else {
        // Handle non-standard formats if any
        const num = parseInt(s.gr_number, 10);
        if (!isNaN(num) && num > maxNum) {
          maxNum = num;
        }
      }
    }

    return `${mainPrefix}${maxNum + 1}`;
  }

  private async computeBalancedHouse(classId: number | null): Promise<number | null> {
    if (!classId) return null;

    const allHouses = await this.prisma.houses.findMany({
        orderBy: { id: 'asc' }
    });
    if (allHouses.length === 0) return null;

    const houseCounts = await this.prisma.students.groupBy({
      by: ['house_id'],
      where: { class_id: classId, house_id: { not: null }, status: 'ENROLLED' },
      _count: { _all: true },
    });

    const countMap = new Map<number, number>();
    houseCounts.forEach((hc) => {
      if (hc.house_id) countMap.set(hc.house_id, hc._count._all);
    });

    let minCount = Infinity;
    let selectedHouseId = allHouses[0].id;

    for (const house of allHouses) {
      const count = countMap.get(house.id) || 0;
      if (count < minCount) {
        minCount = count;
        selectedHouseId = house.id;
      }
    }

    return selectedHouseId;
  }

  private async computeBalancedSection(campusId: number | null, classId: number | null): Promise<number | null> {
    if (!campusId || !classId) return null;

    const availableSections = await this.prisma.campus_sections.findMany({
      where: { campus_id: campusId, class_id: classId, is_active: true },
      select: { section_id: true }
    });

    if (availableSections.length === 0) return null;

    const sectionCounts = await this.prisma.students.groupBy({
      by: ['section_id'],
      where: { 
        campus_id: campusId, 
        class_id: classId, 
        section_id: { in: availableSections.map(s => s.section_id) },
        status: 'ENROLLED'
      },
      _count: { _all: true },
    });

    const countMap = new Map<number, number>();
    sectionCounts.forEach((sc) => {
      if (sc.section_id) countMap.set(sc.section_id, sc._count._all);
    });

    let minCount = Infinity;
    let selectedSectionId = availableSections[0].section_id;

    for (const s of availableSections) {
      const count = countMap.get(s.section_id) || 0;
      if (count < minCount) {
        minCount = count;
        selectedSectionId = s.section_id;
      }
    }

    return selectedSectionId;
  }
}
