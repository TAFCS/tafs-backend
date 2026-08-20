import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { EnrollStudentDto } from './dto/enroll-student.dto';
import { student_status } from '@prisma/client';
import { StudentAllocationService } from '../student-allocation/student-allocation.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ProgressionHistoryService } from '../students/progression-history.service';

@Injectable()
export class EnrollmentService {
  private static readonly SLC_LAST_KEY = 'slc_last_number';
  /** Last SLC already issued outside / before this tracker. Next allocate = 251. */
  private static readonly SLC_SEED_LAST = 250;

  constructor(
    private readonly prisma: PrismaService,
    private readonly allocation: StudentAllocationService,
    private readonly auditLogs: AuditLogsService,
    private readonly progressionHistory: ProgressionHistoryService,
  ) { }

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

  async updatePursuitStatus(cc: number, notPursuing: boolean, changedBy: string) {
    const student = await this.prisma.students.findUnique({
      where: { cc },
    });
    if (!student || student.status !== 'SOFT_ADMISSION') {
      throw new NotFoundException(`Valid candidate with CC #${cc} not found`);
    }
    const updated = await this.prisma.students.update({
      where: { cc },
      data: { not_pursuing: notPursuing },
      include: {
        campuses: { select: { campus_name: true, campus_code: true } },
        classes: { select: { description: true, class_code: true } },
        sections: { select: { description: true } },
        student_admissions: {
          orderBy: { application_date: 'desc' },
          take: 1
        }
      },
    });

    void this.auditLogs.log({
      entity_type: 'STUDENT',
      entity_id: String(cc),
      action: 'PURSUIT_STATUS_UPDATED',
      field: 'not_pursuing',
      old_value: String(student.not_pursuing),
      new_value: String(notPursuing),
      changed_by: changedBy,
      student_id: cc,
      note: `${updated.full_name ?? `Student CC ${cc}`} marked as ${notPursuing ? 'not pursuing' : 'pursuing'} admission.`,
    });

    return updated;
  }

  async getSuggestions(cc: number, sectionId?: number, classId?: number) {
    const student = await this.prisma.students.findUnique({
      where: { cc },
      select: {
        campus_id: true,
        class_id: true,
        graduated_from_class_id: true,
        section_id: true,
        status: true,
        student_admissions: {
          orderBy: { application_date: 'desc' },
          take: 1,
          select: { requested_grade: true, academic_system: true, discipline: true },
        },
        student_alevel_details: {
          select: { details: true }
        }
      },
    });

    if (!student) {
      throw new NotFoundException(`Student #${cc} not found`);
    }

    // Resolve class_id once — students.class_id is null post-registration (and
    // for graduates, where it moved to graduated_from_class_id), so fall back to
    // that and then to matching requested_grade against classes.class_code
    let resolvedClassId = classId ?? student.class_id ?? student.graduated_from_class_id;
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

    const admission = student.student_admissions?.[0];
    const isALevel = admission?.academic_system?.toLowerCase().replace(/[^a-z]/g, '') === 'alevel';

    const targetSectionId = sectionId ?? student.section_id ?? undefined;
    const [suggested_gr, houseDetails, balanced_section, min_gr] = await Promise.all([
      this.computeNextGr(student.campus_id, isALevel),
      this.computeBalancedHouseDetails(resolvedClassId, targetSectionId, student.campus_id),
      this.computeBalancedSection(student.campus_id, resolvedClassId),
      this.computeMinGr(student.campus_id),
    ]);

    let suggested_section = balanced_section;
    let alevel_subjects: Array<{ name: string, code: string }> = [];
    let scienceCount = 0;
    let commerceCount = 0;

    // A-Level Specialized Logic
    if (isALevel) {
      const alevelDetails = (student.student_alevel_details?.details || {}) as any;
      const groupA = alevelDetails.preferred_subjects_group_a || [];
      const groupB = alevelDetails.preferred_subjects_group_b || [];
      const allCodes = Array.from(new Set([...groupA, ...groupB])) as string[];

      // Subject mapping (based on registration-form.tsx)
      const subjectMap: Record<string, string> = {
        "9700": "BIOLOGY",
        "9701": "CHEMISTRY",
        "9702": "PHYSICS",
        "9709": "MATHEMATICS",
        "9686": "URDU",
        "9618": "COMPUTER SCIENCE",
        "9699": "SOCIOLOGY",
        "9706": "ACCOUNTING",
        "9707": "BUSINESS",
        "9708": "ECONOMICS",
      };

      alevel_subjects = allCodes.map(code => ({
        code,
        name: subjectMap[code] || "UNKNOWN"
      }));

      // Categorization
      const scienceCodes = ['9700', '9701', '9702', '9618'];
      const commerceCodes = ['9706', '9707', '9708'];

      allCodes.forEach(code => {
        if (scienceCodes.includes(code)) scienceCount++;
        else if (commerceCodes.includes(code)) commerceCount++;
      });

      // Majority rule for section
      let targetSectionDesc: string | null = null;
      if (scienceCount > commerceCount) targetSectionDesc = 'A';
      else if (commerceCount > scienceCount) targetSectionDesc = 'C';
      // Fallback to explicit discipline field if no clear majority from subjects
      else if (admission?.discipline) {
        const disc = admission.discipline.toLowerCase();
        targetSectionDesc = disc === 'science' ? 'A' : disc === 'commerce' ? 'C' : null;
      }

      if (targetSectionDesc) {
        const matchedSection = await this.prisma.sections.findFirst({
          where: { description: targetSectionDesc }
        });
        if (matchedSection) {
          suggested_section = matchedSection.id;
        }
      }
    }

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

      const occupancyMap = await this.allocation.computeOccupancyStatsBatch(
        campus_sections.map((cs) => ({
          campus_id: cs.campus_id,
          class_id: cs.class_id,
          section_id: cs.section_id,
          student_capacity: cs.student_capacity,
          gender_mode: cs.gender_mode,
        })),
      );

      const seen = new Set();
      available_sections = campus_sections
        .map((cs) => {
          if (!cs.sections || seen.has(cs.sections.id)) return null;
          seen.add(cs.sections.id);
          const key = `${cs.campus_id}:${cs.class_id}:${cs.section_id}`;
          const occupancy = occupancyMap.get(key);
          return {
            id: cs.sections.id,
            description: cs.sections.description,
            student_capacity: cs.student_capacity,
            gender_mode: cs.gender_mode,
            enrolled_count: occupancy?.enrolled_count ?? 0,
            remaining_seats: occupancy?.remaining_seats ?? null,
            is_full: occupancy?.is_full ?? false,
            male_count: occupancy?.male_count ?? 0,
            female_count: occupancy?.female_count ?? 0,
          };
        })
        .filter(Boolean);
    }

    return {
      suggested_gr,
      suggested_house: houseDetails.suggested_house,
      house_counts: houseDetails.house_counts,
      suggested_section,
      min_gr,
      all_houses,
      available_sections,
      alevel_analysis: isALevel ? {
        subjects: alevel_subjects,
        scienceCount: scienceCount,
        commerceCount: commerceCount,
      } : null
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
        houses: true,
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
    const linkGrNumbers = (student.families?.students || [])
      .filter(s => s.gr_number && s.cc !== student.cc)
      .map(s => s.gr_number as string)
      .sort((a, b) => a.localeCompare(b));
    const linkGrNumber = linkGrNumbers.join(', ');

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
      house_name: student.houses?.house_name,
      house_color: student.houses?.house_color,
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

  /**
   * Campus-scoped GR rules shared by first enrollment and readmission:
   *  1. the GR must not already belong to another student in the campus, and
   *  2. it must not fall below the lowest GR sequence already in use there.
   */
  async validateGrNumber(campusId: number | null, cc: number, grNumber: string): Promise<void> {
    const existingGr = await this.prisma.students.findFirst({
      where: {
        campus_id: campusId,
        gr_number: grNumber,
        cc: { not: cc },
        deleted_at: null,
      },
    });
    if (existingGr) {
      throw new BadRequestException(`GR Number ${grNumber} is already assigned to another student in this campus`);
    }

    const matchNew = grNumber.match(/^(.*?)([0-9]+)$/);
    if (!matchNew) return;
    const newNum = parseInt(matchNew[2], 10);

    // Find the minimum numeric GR currently in the campus
    const campusStudents = await this.prisma.students.findMany({
      where: { campus_id: campusId, gr_number: { not: null } },
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
      throw new BadRequestException(`GR Number ${grNumber} is less than the lowest sequence in this campus (Starting from ${minNum})`);
    }
  }

  async enroll(cc: number, dto: EnrollStudentDto, changedBy: string) {
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

    await this.validateGrNumber(student.campus_id, cc, dto.gr_number);

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

    const targetSectionId = dto.section_id ?? student.section_id ?? null;
    const targetCampusId = student.campus_id;
    const targetClassId = resolvedClassId;

    if (
      this.allocation.shouldValidatePlacement({
        campusId: targetCampusId,
        classId: targetClassId,
        sectionId: targetSectionId,
      })
    ) {
      const target = {
        campusId: targetCampusId!,
        classId: targetClassId!,
        sectionId: targetSectionId!,
      };

      return this.allocation.withSectionLock(target, async (tx) => {
        await this.allocation.assertPlacementAllowed(
          target,
          {
            studentCc: cc,
            gender: student.gender,
            countsTowardCapacity: true,
          },
          tx,
        );

        const enrolled = await tx.students.update({
          where: { cc },
          data: {
            status: 'ENROLLED',
            gr_number: dto.gr_number,
            house_id: dto.house_id,
            section_id: dto.section_id || undefined,
            class_id: resolvedClassId ?? undefined,
            doa: new Date(),
          },
          include: {
            campuses: true,
            classes: true,
            sections: true,
            houses: true,
          },
        });

        await this.progressionHistory.recordProgressionChange(tx, {
          studentCc: cc,
          campusId: enrolled.campus_id,
          classId: enrolled.class_id,
          sectionId: enrolled.section_id,
          houseId: enrolled.house_id,
          academicYear: enrolled.academic_year,
          grNumber: enrolled.gr_number,
          changeType: 'ENROLLED',
          changedBy,
        });

        void this.auditLogs.log({
          entity_type: 'STUDENT',
          entity_id: String(cc),
          action: 'ENROLLED',
          changed_by: changedBy,
          student_id: cc,
          note: `${enrolled.full_name ?? `Student CC ${cc}`} enrolled with GR ${enrolled.gr_number ?? '—'}, class ${enrolled.classes?.description ?? '—'}, section ${enrolled.sections?.description ?? '—'}.`,
        });

        return enrolled;
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const enrolled = await tx.students.update({
        where: { cc },
        data: {
          status: 'ENROLLED',
          gr_number: dto.gr_number,
          house_id: dto.house_id,
          section_id: dto.section_id || undefined,
          class_id: resolvedClassId ?? undefined,
          doa: new Date(),
        },
        include: {
          campuses: true,
          classes: true,
          sections: true,
          houses: true,
        },
      });

      await this.progressionHistory.recordProgressionChange(tx, {
        studentCc: cc,
        campusId: enrolled.campus_id,
        classId: enrolled.class_id,
        sectionId: enrolled.section_id,
        houseId: enrolled.house_id,
        academicYear: enrolled.academic_year,
        grNumber: enrolled.gr_number,
        changeType: 'ENROLLED',
        changedBy,
      });

      void this.auditLogs.log({
        entity_type: 'STUDENT',
        entity_id: String(cc),
        action: 'ENROLLED',
        changed_by: changedBy,
        student_id: cc,
        note: `${enrolled.full_name ?? `Student CC ${cc}`} enrolled with GR ${enrolled.gr_number ?? '—'}, class ${enrolled.classes?.description ?? '—'}, section ${enrolled.sections?.description ?? '—'}.`,
      });

      return enrolled;
    });
  }

  private async computeNextGr(campusId: number | null, isALevel = false): Promise<string> {
    if (!campusId) return '1';

    // Get campus details for prefix logic
    const campus = await this.prisma.campuses.findUnique({
      where: { id: campusId },
      select: { campus_name: true, campus_prefix: true } as any,
    }) as any;

    const getPrefixByCampusName = (name: string, campusId: number) => {
      const uname = name.toUpperCase();
      if (uname.includes('KANEEZ FATIMA') || campusId === 2) return 'KF-A';
      if (uname.includes('NORTH NAZIMABAD') || campusId === 3) return 'A-N';
      return '';
    };

    const defaultPrefix = isALevel 
      ? 'A-' 
      : (campus?.campus_prefix || (campus ? getPrefixByCampusName(campus.campus_name, campusId) : ''));

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

          // Logic: Separate sequences for A-Level vs everything else
          const isThisGrALevel = prefix === 'A-';
          if (isThisGrALevel !== isALevel) continue;

          // Harden: Ensure the prefix matches the expected defaultPrefix for the campus/level
          if (prefix !== defaultPrefix) continue;

          if (num > maxNum) {
            maxNum = num;
            mainPrefix = prefix || defaultPrefix;
          }
        } else if (!isALevel && defaultPrefix === '') {
          // For non-A-Level, also check purely numeric GRs if no prefix match found yet
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

  private async computeBalancedHouseDetails(
    classId: number | null,
    sectionId?: number,
    campusId?: number | null,
  ): Promise<{ suggested_house: number | null; house_counts: Record<number, number> }> {
    const allHouses = await this.prisma.houses.findMany({
      orderBy: { id: 'asc' },
    });
    if (allHouses.length === 0) return { suggested_house: null, house_counts: {} };

    const getCounts = async (scope: { class_id?: number; section_id?: number; campus_id?: number }) => {
      const houseCounts = await this.prisma.students.groupBy({
        by: ['house_id'],
        where: {
          house_id: { not: null },
          deleted_at: null,
          status: { notIn: ['EXPELLED', 'GRADUATED', 'LEFT'] },
          ...scope,
        },
        _count: { _all: true },
      });
      const countMap: Record<number, number> = {};
      for (const h of allHouses) {
        countMap[h.id] = 0;
      }
      let totalCount = 0;
      houseCounts.forEach((hc) => {
        if (hc.house_id) {
          countMap[hc.house_id] = hc._count._all;
          totalCount += hc._count._all;
        }
      });
      return { countMap, totalCount };
    };

    let result = { countMap: {} as Record<number, number>, totalCount: 0 };

    if (sectionId) {
      result = await getCounts({ section_id: Number(sectionId) });
    }

    if (result.totalCount === 0 && classId) {
      result = await getCounts({ class_id: Number(classId) });
    }

    if (result.totalCount === 0 && campusId) {
      result = await getCounts({ campus_id: Number(campusId) });
    }

    if (result.totalCount === 0) {
      result = await getCounts({});
    }

    const { countMap } = result;

    let minCount = Infinity;
    let selectedHouseId = allHouses[0].id;

    for (const house of allHouses) {
      const count = countMap[house.id] || 0;
      if (count < minCount) {
        minCount = count;
        selectedHouseId = house.id;
      }
    }

    return {
      suggested_house: selectedHouseId,
      house_counts: countMap,
    };
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

  /**
   * Allocates a unique SLC serial for the student if they don't already have one.
   * Tracker is seeded so the last issued number is 250 → next is 251.
   */
  async allocateSlcNumber(cc: number): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const student = await tx.students.findUnique({
        where: { cc },
        select: { cc: true, slc_number: true },
      });
      if (!student) {
        throw new NotFoundException(`Student with CC #${cc} not found`);
      }
      if (student.slc_number != null) {
        return student.slc_number;
      }

      let config = await tx.app_config.findUnique({
        where: { key: EnrollmentService.SLC_LAST_KEY },
      });
      if (!config) {
        config = await tx.app_config.create({
          data: {
            key: EnrollmentService.SLC_LAST_KEY,
            value: String(EnrollmentService.SLC_SEED_LAST),
            description:
              'Last issued School Leaving Certificate (SLC) number. Next issued = this + 1.',
            updated_at: new Date(),
            updated_by: 'SYSTEM',
          },
        });
      }

      const maxAssigned = await tx.students.aggregate({
        _max: { slc_number: true },
      });
      const lastFromConfig = parseInt(config.value, 10);
      const lastFromStudents = maxAssigned._max.slc_number ?? 0;
      const last = Math.max(
        Number.isFinite(lastFromConfig) ? lastFromConfig : 0,
        lastFromStudents,
        EnrollmentService.SLC_SEED_LAST,
      );
      const next = last + 1;

      await tx.app_config.update({
        where: { key: EnrollmentService.SLC_LAST_KEY },
        data: {
          value: String(next),
          updated_by: 'SYSTEM',
          updated_at: new Date(),
        },
      });

      await tx.students.update({
        where: { cc },
        data: { slc_number: next },
      });

      return next;
    });
  }

  async getLeavingCertificateData(cc: number) {
    const student = await this.prisma.students.findUnique({
      where: { cc },
      include: {
        campuses: true,
        classes: true,
        sections: true,
        houses: true,
        student_admissions: {
          orderBy: { application_date: 'desc' },
          take: 1,
        },
        student_guardians: {
          include: {
            guardians: true,
          },
        },
        student_previous_schools: {
          orderBy: { id: 'desc' },
          take: 1,
        },
      },
    });

    if (!student) {
      throw new NotFoundException(`Student with CC #${cc} not found`);
    }

    const slcNumber = await this.allocateSlcNumber(cc);

    const fatherLink = student.student_guardians.find(g => g.relationship?.toLowerCase() === 'father');
    const fatherFullName = fatherLink?.guardians?.full_name || '';

    const splitName = (fullName: string) => {
      const parts = (fullName || '').trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) return { last: '', first: '', middle: '' };
      if (parts.length === 1) return { last: parts[0], first: '', middle: '' };
      if (parts.length === 2) return { last: parts[0], first: parts[1], middle: '' };
      return { last: parts[0], first: parts[1], middle: parts.slice(2).join(' ') };
    };

    const monthNames = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
    const parseDateParts = (dateVal: Date | string | null) => {
      if (!dateVal) return { month: '—', day: '—', year: '—' };
      const d = new Date(dateVal);
      if (isNaN(d.getTime())) return { month: '—', day: '—', year: '—' };
      return {
        month: monthNames[d.getMonth()],
        day: String(d.getDate()).padStart(2, '0'),
        year: String(d.getFullYear()),
      };
    };

    const parseAcademicYear = (ay: string | null) => {
      if (!ay) return { from: '—', to: '—' };
      const parts = ay.split('-');
      return { from: parts[0] || '—', to: parts[1] || '—' };
    };

    const now = new Date();
    const dayNames = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];

    const admission = student.student_admissions?.[0];
    const prevSchool = student.student_previous_schools?.[0];

    const studentNameParts = splitName(student.full_name || '');
    const fatherNameParts = splitName(fatherFullName);

    const admissionAy = parseAcademicYear(student.academic_year || admission?.academic_year || null);
    const currentAy = parseAcademicYear(student.academic_year || null);

    const resolvePrefix = () => {
      const code = (student.classes?.class_code || '').trim().toUpperCase();
      const desc = (student.classes?.description || '').trim().toUpperCase();
      const system = (student.classes?.academic_system || '').trim().toUpperCase();

      // A-Levels -> TAFSAL
      if (system === 'A-LEVEL' || code === 'AS' || code === 'A2' || desc.includes('A-LEVEL') || desc === 'AS' || desc === 'A2') {
        return 'TAFSAL';
      }

      // Secondary 6-10 -> TAFSS
      if (
        system === 'SECONDARY' ||
        ['VI', 'VII', 'VIII', 'IX', 'X'].includes(code) ||
        ['CLASS VI', 'CLASS VII', 'CLASS VIII', 'CLASS IX', 'CLASS X', '6', '7', '8', '9', '10'].includes(desc) ||
        ['VI', 'VII', 'VIII', 'IX', 'X'].includes(desc)
      ) {
        return 'TAFSS';
      }

      // O-Levels -> TAFCS
      if (['OI', 'OII', 'OIII', 'O-I', 'O-II', 'O-III'].includes(code) || desc.startsWith('O-') || desc.includes('O-LEVEL')) {
        return 'TAFCS';
      }

      // Seniors -> TAFCS
      if (['SRI', 'SRII', 'SRIII', 'SR-I', 'SR-II', 'SR-III'].includes(code) || desc.startsWith('SR-')) {
        return 'TAFCS';
      }

      // Juniors -> TAFS
      if (['JRI', 'JRII', 'JRIII', 'JRIV', 'JRV', 'JR-I', 'JR-II', 'JR-III', 'JR-IV', 'JR-V'].includes(code) || desc.startsWith('JR-')) {
        return 'TAFS';
      }

      // Pre primary -> TAFS
      if (['PN', 'NUR', 'KG'].includes(code) || desc.includes('PRE') || desc.includes('NURSERY') || desc.includes('K.G.')) {
        return 'TAFS';
      }

      return 'TAFS';
    };

    const headerPrefix = resolvePrefix();
    const headerTitle = `${headerPrefix} LEAVING CERTIFICATE`;

    return {
      header_title: headerTitle,
      header_prefix: headerPrefix,
      slc_number: String(slcNumber),
      cc: student.cc,
      gr_number: student.gr_number || '—',
      name: {
        last: studentNameParts.last.toUpperCase(),
        first: studentNameParts.first.toUpperCase(),
        middle: studentNameParts.middle.toUpperCase(),
      },
      father_name: {
        last: fatherNameParts.last.toUpperCase(),
        first: fatherNameParts.first.toUpperCase(),
        middle: fatherNameParts.middle.toUpperCase(),
      },
      dob: parseDateParts(student.dob),
      place_of_birth: {
        country: (student.country || 'PAKISTAN').toUpperCase(),
        province: (student.province || 'SINDH').toUpperCase(),
        city: (student.city || 'KARACHI').toUpperCase(),
      },
      nationality: (student.nationality || 'PAKISTANI').toUpperCase(),
      gender: (student.gender || 'MALE').toUpperCase(),
      religion: (student.religion || 'MUSLIM').toUpperCase(),
      identification_marks: student.identification_marks || '—',
      last_school_attended: prevSchool?.school_name || '—',
      date_of_admission: parseDateParts(student.doa || student.created_at),
      scholastic_year_admitted: admissionAy,
      class_admitted: admission?.requested_grade || student.classes?.class_code || '—',
      present_level: student.classes?.description || student.classes?.class_code || '—',
      section: student.sections?.description || '—',
      scholastic_year_present: currentAy,
      last_date_of_attendance: parseDateParts(now),
      reason_for_leaving: "ON PARENT'S REQUEST",
      result_scholastic_year: currentAy,
      passed_promoted_level: student.classes?.description || student.classes?.class_code || '—',
      passed_promoted_year: currentAy,
      resit_subjects: '—',
      detained_level: '—',
      detained_year: { from: '—', to: '—' },
      school_dues: '—',
      remarks: `COMPLETED ACADEMIC SESSION ${currentAy.from}-${currentAy.to}`,
      prepared_by: '',
      rechecked_by: '',
      posted_by: '',
      class_teacher: '',
      programme_directress: '',
      day: dayNames[now.getDay()],
      date: `${monthNames[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`,
      photograph_url: student.photograph_url || null,
      campus_name: student.campuses?.campus_name || '',
      campus_address: student.campuses?.address || 'C-61 - 65, Block # 13, Gulistan-e-Jauhar, Karachi, Pakistan.',
    };
  }

  async getAllHouses() {
    return this.prisma.houses.findMany({
      orderBy: { house_name: 'asc' },
    });
  }
}
