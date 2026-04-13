import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { EnrollStudentDto } from './dto/enroll-student.dto';
import { student_status } from '@prisma/client';

@Injectable()
export class EnrollmentService {
  constructor(private readonly prisma: PrismaService) { }

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
      select: {
        campus_id: true,
        class_id: true,
        status: true,
        student_admissions: {
          orderBy: { application_date: 'desc' },
          take: 1,
          select: { requested_grade: true },
        },
      },
    });

    if (!student || student.status !== 'SOFT_ADMISSION') {
      throw new NotFoundException(`Valid candidate with CC #${cc} not found`);
    }

    // Resolve class_id once — students.class_id is null post-registration,
    // so fall back to matching requested_grade against classes.class_code
    let resolvedClassId = student.class_id;
    if (!resolvedClassId) {
      const requestedGrade = student.student_admissions?.[0]?.requested_grade;
      if (requestedGrade) {
        // Match against class_code (e.g. 'JRIII') or normalized version of requestedGrade (e.g. 'JR-III' -> 'JRIII')
        const normalized = requestedGrade.replace(/[-\s]/g, '').toUpperCase();
        const matched = await this.prisma.classes.findFirst({
          where: {
            OR: [
              { class_code: requestedGrade },
              { class_code: normalized },
            ],
          },
          select: { id: true },
        });
        resolvedClassId = matched?.id ?? null;
      }
    }

    const [suggested_gr, suggested_house, suggested_section] = await Promise.all([
      this.computeNextGr(student.campus_id),
      this.computeBalancedHouse(resolvedClassId),
      this.computeBalancedSection(student.campus_id, resolvedClassId),
    ]);

    const all_houses = await this.prisma.houses.findMany();

    let available_sections: any[] = [];
    if (student.campus_id && resolvedClassId) {
      const campus_sections = await this.prisma.campus_sections.findMany({
        where: {
          campus_id: student.campus_id,
          class_id: resolvedClassId,
          is_active: true,
        },
        include: { sections: true },
      });
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
      available_sections,
    };
  }

  async getAdmissionOrderData(cc: number) {
    const student = await this.prisma.students.findUnique({
      where: { cc },
      include: {
        campuses: true,
        classes: true,
        sections: true,
        families: true,
        student_admissions: {
          orderBy: { application_date: 'desc' },
          take: 1,
        },
        student_guardians: {
          include: {
            guardians: true,
          },
        },
      },
    });

    if (!student) {
      throw new NotFoundException(`Student with CC #${cc} not found`);
    }

    const fatherLink = student.student_guardians.find(g => g.relationship?.toLowerCase() === 'father');
    const motherLink = student.student_guardians.find(g => g.relationship?.toLowerCase() === 'mother');

    return {
      cc: student.cc,
      gr_number: student.gr_number,
      full_name: student.full_name,
      dob: student.dob,
      gender: student.gender,
      doa: student.doa,
      academic_year: student.academic_year || student.student_admissions[0]?.academic_year,
      campus_name: student.campuses?.campus_name,
      class_name: student.classes?.description,
      section_name: student.sections?.description,
      address: fatherLink?.guardians?.mailing_address || student.families?.primary_address,
      home_phone: student.families?.home_phone,
      father_name: fatherLink?.guardians?.full_name,
      father_cell: fatherLink?.guardians?.primary_phone,
      mother_cell: motherLink?.guardians?.primary_phone,
      email: student.email || student.families?.email,
      fax: fatherLink?.guardians?.fax_number,
    };
  }

  async enroll(cc: number, dto: EnrollStudentDto) {
    const student = await this.prisma.students.findUnique({
      where: { cc },
      include: {
        student_admissions: {
          orderBy: { application_date: 'desc' },
          take: 1,
          select: { requested_grade: true },
        },
      },
    });

    if (!student || student.status !== 'SOFT_ADMISSION') {
      throw new BadRequestException(`Student #${cc} is not eligible for enrollment`);
    }

    // Persist the resolved class_id on the student record during enrollment
    let resolvedClassId = student.class_id;
    if (!resolvedClassId) {
      const requestedGrade = student.student_admissions?.[0]?.requested_grade;
      if (requestedGrade) {
        const normalized = requestedGrade.replace(/[-\s]/g, '').toUpperCase();
        const matched = await this.prisma.classes.findFirst({
          where: {
            OR: [
              { class_code: requestedGrade },
              { class_code: normalized },
            ],
          },
          select: { id: true },
        });
        resolvedClassId = matched?.id ?? null;
      }
    }

    return this.prisma.students.update({
      where: { cc },
      data: {
        status: 'ENROLLED',
        gr_number: dto.gr_number,
        house_id: dto.house_id,
        section_id: dto.section_id || undefined,
        class_id: resolvedClassId ?? undefined, // writes it so future queries don't need the fallback
        doa: new Date(),
      },
      include: {
        campuses: true,
        classes: true,
        sections: true,
        houses: true,
      },
    });
  }

  private async computeNextGr(campusId: number | null): Promise<string> {
    if (!campusId) return '1';

    // Get campus name for prefix logic
    const campus = await this.prisma.campuses.findUnique({
      where: { id: campusId },
      select: { campus_name: true },
    });

    const getPrefixByCampusName = (name: string) => {
      const uname = name.toUpperCase();
      if (uname.includes('KANEEZ FATIMA')) return 'KF-A';
      if (uname.includes('NORTH NAZIMABAD')) return 'A-N';
      return '';
    };

    const defaultPrefix = campus ? getPrefixByCampusName(campus.campus_name) : '';

    // Optimize: Instead of fetching ALL students, fetch the most recent ones 
    // to determine the current GR sequence and prefix.
    const students = await this.prisma.students.findMany({
      where: { campus_id: campusId, gr_number: { not: null } },
      select: { gr_number: true },
      orderBy: { cc: 'desc' },
      take: 500, // Look at the last 500 admissions to find the max GR
    });

    if (students.length === 0) return `${defaultPrefix}1`;

    let maxNum = 0;
    let mainPrefix = defaultPrefix;

    for (const s of students) {
      if (!s.gr_number) continue;

      // Match pattern like "ABC-123" or just "123"
      const match = s.gr_number.match(/^(.*?)([0-9]+)$/);
      if (match) {
        const prefix = match[1];
        const num = parseInt(match[2], 10);
        if (num > maxNum) {
          maxNum = num;
          mainPrefix = prefix || defaultPrefix;
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
