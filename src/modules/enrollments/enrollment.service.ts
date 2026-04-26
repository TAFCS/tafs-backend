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

  async getSuggestions(cc: number, sectionId?: number) {
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

    const [suggested_gr, suggested_house, suggested_section, min_gr] = await Promise.all([
      this.computeNextGr(student.campus_id),
      this.computeBalancedHouse(resolvedClassId, sectionId),
      this.computeBalancedSection(student.campus_id, resolvedClassId),
      this.computeMinGr(student.campus_id),
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
      min_gr,
      all_houses,
      available_sections,
    };
  }

  private async computeMinGr(campusId: number | null): Promise<string | null> {
    if (!campusId) return null;
    const campusStudents = await this.prisma.students.findMany({
      where: { campus_id: campusId, gr_number: { not: null } },
      select: { gr_number: true },
    });
    if (campusStudents.length === 0) return null;

    let minNum = Infinity;
    let minGrStr: string | null = null;

    for (const s of campusStudents) {
      if (!s.gr_number) continue;
      const m = s.gr_number.match(/^(.*?)([0-9]+)$/);
      if (m) {
        const n = parseInt(m[2], 10);
        if (n < minNum) {
          minNum = n;
          minGrStr = s.gr_number;
        }
      }
    }
    return minGrStr;
  }

  async getAdmissionOrderData(cc: number) {
    const student = await this.prisma.students.findUnique({
      where: { cc },
      include: {
        campuses: true,
        classes: true,
        sections: true,
        families: {
          include: {
            students: {
              where: { gr_number: { not: null } },
              select: { 
                cc: true,
                gr_number: true,
              },
            },
          },
        },
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
    const emergencyContact = student.student_guardians.find(g => g.is_emergency_contact);

    // Scholastic year formatting
    const academicYear = student.academic_year || student.student_admissions[0]?.academic_year;
    let scholasticYear = '';
    if (academicYear) {
      const parts = academicYear.split('-');
      if (parts.length === 2) {
        scholasticYear = `${parts[0]}-${parts[1]}`;
      } else {
        scholasticYear = academicYear;
      }
    }

    // Get link_gr_number from other family members (siblings)
    const linkGrNumber = student.families?.students.find(s => s.gr_number && s.cc !== student.cc)?.gr_number;

    // Auto-fetch current Day and Date
    const now = new Date();
    const dayNames = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
    const monthNames = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
    const currentDay = dayNames[now.getDay()];
    const currentDate = `${monthNames[now.getMonth()]} ${now.getDate().toString().padStart(2, '0')}, ${now.getFullYear()}`;

    // Segment head based on class
    let segmentHead = '';
    if (student.classes?.academic_system === 'CAMBRIDGE') {
      const classCode = student.classes.class_code.toUpperCase();
      if (classCode.includes('JUNIOR')) {
        segmentHead = 'JUNIOR CAMBRIDGE';
      } else {
        segmentHead = 'CAMBRIDGE';
      }
    } else {
      segmentHead = student.classes?.academic_system || '';
    }

    // Construct address from available fields
    let address = '';

    // First, try to get mailing_address from any guardian
    for (const sg of student.student_guardians) {
      if (sg.guardians?.mailing_address) {
        address = sg.guardians.mailing_address;
        break; // Use the first available mailing_address
      }
    }

    // If no mailing_address found, try family primary_address
    if (!address) {
      address = student.families?.primary_address || '';
    }

    // If still no address, try to construct from any guardian's address components
    if (!address) {
      for (const sg of student.student_guardians) {
        if (sg.guardians) {
          const guardian = sg.guardians;
          const addressParts = [
            guardian.house_appt_name,
            guardian.house_appt_number,
            guardian.area_block,
            guardian.city,
            guardian.province,
            guardian.country
          ].filter(Boolean);
          if (addressParts.length > 0) {
            address = addressParts.join(', ');
            break; // Use the first guardian with address components
          }
        }
      }
    }

    const formatPhone = (phone: string | null | undefined) => {
      if (!phone) return '';
      let cleaned = phone.toString().replace(/\D/g, ''); // Remove non-digits
      if (!cleaned) return '';
      
      // If starts with 0, remove it (e.g., 0300 -> 300)
      if (cleaned.startsWith('0')) cleaned = cleaned.substring(1);
      // If already starts with 92, just prepend +
      if (cleaned.startsWith('92')) return `+${cleaned}`;
      // Otherwise prepend +92
      return `+92${cleaned}`;
    };

    return {
      cc: student.cc,
      gr_number: student.gr_number,
      reg_number: student.cc.toString(),
      link_gr_number: linkGrNumber || '',
      day: currentDay,
      date: currentDate,
      full_name: student.full_name,
      dob: student.dob,
      gender: student.gender,
      doa: student.doa,
      scholastic_year: scholasticYear,
      academic_year: academicYear,
      campus_name: student.campuses?.campus_name,
      class_name: student.classes?.description,
      section_name: student.sections?.description,
      segment_head: segmentHead,
      address: address,
      home_phone: student.families?.home_phone,
      father_name: fatherLink?.guardians?.full_name,
      father_cell: formatPhone(fatherLink?.guardians?.primary_phone),
      mother_cell: formatPhone(motherLink?.guardians?.primary_phone),
      nearest_name: emergencyContact?.guardians?.full_name || '',
      nearest_phone: formatPhone(emergencyContact?.guardians?.primary_phone),
      nearest_relationship: emergencyContact?.relationship || '',
      email: student.email || student.families?.email,
      fax: fatherLink?.guardians?.fax_number,
      photograph_url: student.photograph_url || student.photo_blue_bg_url,
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

    // 1. Check for Duplicate GR in the same campus
    const existingGr = await this.prisma.students.findFirst({
      where: {
        campus_id: student.campus_id,
        gr_number: dto.gr_number,
        cc: { not: cc },
        deleted_at: null,
      },
    });
    if (existingGr) {
      throw new BadRequestException(`GR Number ${dto.gr_number} is already assigned to another student in this campus`);
    }

    // 2. Minimum GR Constraint: Ensure new GR is not less than the lowest GR in the campus
    const matchNew = dto.gr_number.match(/^(.*?)([0-9]+)$/);
    if (matchNew) {
      const newNum = parseInt(matchNew[2], 10);
      
      // Find the minimum numeric GR currently in the campus
      const campusStudents = await this.prisma.students.findMany({
        where: { campus_id: student.campus_id, gr_number: { not: null } },
        select: { gr_number: true },
      });

      let minNum = Infinity;
      for (const s of campusStudents) {
        if (!s.gr_number) continue;
        const m = s.gr_number.match(/^(.*?)([0-9]+)$/);
        if (m) {
          const n = parseInt(m[2], 10);
          if (n < minNum) minNum = n;
        }
      }

      if (minNum !== Infinity && newNum < minNum) {
        throw new BadRequestException(`GR Number ${dto.gr_number} is less than the lowest sequence in this campus (Starting from ${minNum})`);
      }
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

    let maxNum = 0;
    let mainPrefix = defaultPrefix;

    if (students.length > 0) {
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
    }

    let nextNum = maxNum + 1;
    let finalGr = `${mainPrefix}${nextNum}`;

    // Robust uniqueness check: Ensure this GR is truly not present in this campus
    let isTaken = true;
    while (isTaken) {
      const existing = await this.prisma.students.findFirst({
        where: { campus_id: campusId, gr_number: finalGr },
        select: { cc: true }
      });
      if (!existing) {
        isTaken = false;
      } else {
        nextNum++;
        finalGr = `${mainPrefix}${nextNum}`;
      }
    }

    return finalGr;
  }

  private async computeBalancedHouse(classId: number | null, sectionId?: number): Promise<number | null> {
    if (!classId) return null;

    const allHouses = await this.prisma.houses.findMany({
      orderBy: { id: 'asc' }
    });
    if (allHouses.length === 0) return null;

    const houseCounts = await this.prisma.students.groupBy({
      by: ['house_id'],
      where: { 
        class_id: classId, 
        section_id: sectionId ? Number(sectionId) : undefined,
        house_id: { not: null }, 
        status: 'ENROLLED' 
      },
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
