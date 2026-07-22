import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../../../prisma/prisma.service';
import { GetStudentsDto } from './dto/get-students.dto';
import { calculateOffset } from '../../utils/pagination.util';
import { createPaginationMeta } from '../../utils/serializer.util';
import { Prisma } from '@prisma/client';
import { ClassSelectorDto } from './dto/class-selector.dto';
import { PromoteSingleStudentDto } from './dto/promote-single-student.dto';
import { PromoteBulkStudentsDto } from './dto/promote-bulk-students.dto';
import { StudentStatus } from '../../constants/student-status.constant';
import { applyStudentScope } from '../../common/staff-scope';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { allocateSequentialGrNumbers } from '../../common/utils/gr-number.util';

type PromotionStatus = 'promoted' | 'graduated' | 'expelled' | 'left' | 'skipped' | 'failed';

type PromotionReasonCode =
  | 'STUDENT_NOT_FOUND'
  | 'FROM_CLASS_MISMATCH'
  | 'ALREADY_AT_TARGET'
  | 'ALREADY_GRADUATED'
  | 'ALREADY_EXPELLED'
  | 'ALREADY_LEFT'
  | 'TARGET_CLASS_INACTIVE_FOR_CAMPUS'
  | 'TARGET_SECTION_INVALID_FOR_CLASS_CAMPUS'
  | 'MISSING_TARGET'
  | 'GR_DUPLICATE'
  | 'SECTION_FULL'
  | 'SECTION_GENDER_RESTRICTED'
  | 'STUDENT_GENDER_REQUIRED'
  | 'SECTION_NOT_OFFERED'
  | 'SECTION_INACTIVE'
  | 'INTERNAL_ERROR';

type PromotionOutcome = {
  student_id: number;
  status: PromotionStatus;
  reason_code?: PromotionReasonCode;
  message: string;
  from_class_id?: number | null;
  to_class_id?: number | null;
  from_academic_year?: string | null;
  to_academic_year?: string;
  graduated?: boolean;
  expelled?: boolean;
  left?: boolean;
  dry_run: boolean;
};

type ResolvedClass = {
  id: number;
  description: string;
  class_code: string;
  academic_system: string;
};

import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { StudentAllocationService } from '../student-allocation/student-allocation.service';
import { ALLOCATION_ERROR_CODES } from '../student-allocation/student-allocation.types';
import { ProgressionHistoryService } from './progression-history.service';

@Injectable()
export class StudentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly allocation: StudentAllocationService,
    private readonly progressionHistory: ProgressionHistoryService,
  ) { }

  async resolveClassIdForStudent(cc: number, classId?: number | null): Promise<number | null> {
    if (classId) return classId;

    const student = await this.prisma.students.findUnique({
      where: { cc },
      select: {
        class_id: true,
        status: true,
        student_admissions: {
          orderBy: { application_date: 'desc' },
          take: 1,
          select: { requested_grade: true },
        },
      },
    });

    if (!student) return null;
    if (student.class_id) return student.class_id;

    const requestedGrade = student.student_admissions?.[0]?.requested_grade;
    if (!requestedGrade) return null;

    const normalized = requestedGrade.replace(/[-\s]/g, '').toUpperCase();
    const matchedClass = await this.prisma.classes.findFirst({
      where: {
        OR: [
          { class_code: { equals: requestedGrade, mode: 'insensitive' } },
          { class_code: { equals: normalized, mode: 'insensitive' } },
          { description: { equals: requestedGrade, mode: 'insensitive' } },
        ],
      },
      select: { id: true },
    });

    return matchedClass?.id ?? null;
  }

  private formatSiblingGrade(sib: {
    classes?: { description: string } | null;
    sections?: { description: string } | null;
    student_admissions?: { requested_grade: string }[];
  }): string | undefined {
    if (sib.classes?.description) {
      const section = sib.sections?.description;
      return section ? `${sib.classes.description} (${section})` : sib.classes.description;
    }
    return sib.student_admissions?.[0]?.requested_grade ?? undefined;
  }

  private mapSiblingForResponse(sib: any) {
    return {
      id: sib.cc,
      cc: sib.cc,
      full_name: sib.full_name,
      cc_number: sib.cc,
      gr_number: sib.gr_number ?? null,
      grade: this.formatSiblingGrade(sib),
      father_name: sib.student_guardians?.[0]?.guardians?.full_name,
    };
  }

  private readonly familySiblingSelect = {
    cc: true,
    full_name: true,
    gr_number: true,
    classes: { select: { description: true } },
    sections: { select: { description: true } },
    student_admissions: {
      orderBy: { application_date: 'desc' as const },
      take: 1,
      select: { requested_grade: true },
    },
    student_guardians: {
      take: 1,
      select: {
        guardians: { select: { full_name: true } },
      },
    },
  };

  private readonly assignmentInclude = {
    campuses: { select: { campus_name: true, campus_code: true } },
    classes: { select: { description: true, class_code: true } },
    graduated_from_class: { select: { id: true, description: true, class_code: true } },
    sections: { select: { description: true } },
    houses: { select: { house_name: true } },
  } as const;

  private async getFinancialDigest(studentId: number) {
    const [fees, deposits, allocations] = await Promise.all([
      this.prisma.student_fees.findMany({
        where: { student_id: studentId },
        select: { amount: true, amount_paid: true, due_date: true, status: true }
      }),
      this.prisma.deposits.findMany({
        where: { student_id: studentId },
        select: { total_amount: true }
      }),
      this.prisma.deposit_allocations.findMany({
        where: { deposits: { student_id: studentId } },
        select: { amount: true }
      })
    ]);

    const totalDeposits = deposits.reduce((sum, d) => sum.add(d.total_amount || 0), new Prisma.Decimal(0));
    const totalAllocations = allocations.reduce((sum, a) => sum.add(a.amount || 0), new Prisma.Decimal(0));
    const advance = totalDeposits.sub(totalAllocations);

    if (fees.length === 0) {
      return {
        badge: 'NO_SCHEDULE',
        outstanding: 0,
        advance: advance.toNumber()
      };
    }

    let outstanding = new Prisma.Decimal(0);
    let anyOverdue = false;
    let anyPartial = false;
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    for (const fee of fees) {
      const balance = new Prisma.Decimal(fee.amount || 0).sub(fee.amount_paid || 0);
      if (balance.gt(0)) {
        outstanding = outstanding.add(balance);
        if (fee.due_date && fee.due_date < now) {
          anyOverdue = true;
        }
        if (new Prisma.Decimal(fee.amount_paid || 0).gt(0)) {
          anyPartial = true;
        }
      }
    }

    let badge = 'Cleared';
    if (anyOverdue) badge = 'Overdue';
    else if (outstanding.gt(0)) badge = anyPartial ? 'Partial' : 'Partial'; // default to Partial if any unpaid

    // If outstanding > 0 but not overdue or partial, it's just 'Partial' (or we could add 'Pending')
    // Existing frontend only handles Cleared, Overdue, Partial.
    // I'll map anything with balance to 'Partial' for now to fit existing styles, or just use the logic below.
    if (anyOverdue) badge = 'Overdue';
    else if (outstanding.gt(0)) {
        badge = anyPartial ? 'Partial' : 'Partial';
    } else {
        badge = 'Cleared';
    }

    return {
      badge,
      outstanding: outstanding.toNumber(),
      advance: advance.toNumber()
    };
  }

  async buildStudentsWhere(
    query: GetStudentsDto,
    user?: IJwtStaffPayload,
  ): Promise<Prisma.studentsWhereInput> {
    const { search, campus_id, class_id, section_id, house_id, status, has_photo } = query;
    const where: Prisma.studentsWhereInput = { deleted_at: null };

    if (search) {
      const isNumeric = /^\d+$/.test(search);
      const isShortNumeric = isNumeric && search.length <= 5;

      where.OR = [
        { full_name: { contains: search, mode: 'insensitive' } },
        { gr_number: { contains: search, mode: 'insensitive' } },
        ...(isNumeric ? [{ cc: Number(search) }] : []),
        // Only search CNIC if it's not a short numeric string (likely intended for CC/GR)
        ...(!isShortNumeric ? [{
          student_guardians: {
            some: {
              guardians: {
                cnic: { contains: search, mode: Prisma.QueryMode.insensitive }
              }
            }
          }
        }] : []),
      ];
    }
    if (campus_id)   where.campus_id  = campus_id;
    if (class_id)    where.class_id   = class_id;
    if (section_id)  where.section_id = section_id;
    if (house_id)    where.house_id   = house_id;
    // UNCONFIRMED is kept as an alias for QUICK_ADMISSION (real students status).
    if (status === 'UNCONFIRMED') {
      where.status = StudentStatus.QUICK_ADMISSION as any;
    } else if (status) {
      where.status = status as any;
    }

    // Data Audit Filters
    const auditType = query.audit_type || (query.is_abnormal === '1' || query.is_abnormal === 'true' || (query as any).is_abnormal === true ? 'abnormal' : null);

    if (auditType) {
      if (auditType === 'no_family') {
        where.family_id = null;
      } else if (auditType === 'missing_guardian') {
        where.student_guardians = { none: {} };
      } else if (auditType === 'abnormal') {
        const abnormalStudents: any[] = await this.prisma.$queryRaw`
          SELECT student_id FROM public.student_guardians
          GROUP BY student_id
          HAVING COUNT(*) > 2
        `;
        const abnormalCcs = abnormalStudents.map(s => s.student_id);
        where.cc = { in: abnormalCcs };
      }
    }

    if (has_photo === 'true') {
      if (!where.AND) where.AND = [];
      (where.AND as any).push({
        photograph_url: { not: null }
      }, {
        photograph_url: { not: '' }
      });
    } else if (has_photo === 'false') {
      if (!where.AND) where.AND = [];
      (where.AND as any).push({
        OR: [
          { photograph_url: null },
          { photograph_url: '' }
        ]
      });
    }

    if (user) {
      return applyStudentScope(user, where, {
        campus_id: campus_id,
        class_id: class_id,
      });
    }

    return where;
  }

  /**
   * Remaining unconfirmed_admissions rows (collision leftovers after migration,
   * or not-yet-migrated rows). Migrated non-colliding rows are deleted from this
   * table by the migration script so they do not duplicate QUICK_ADMISSION students.
   */
  private buildLeftoverUnconfirmedWhere(
    query: GetStudentsDto,
    user?: IJwtStaffPayload,
  ): Prisma.unconfirmed_admissionsWhereInput | null {
    const { search, campus_id, class_id, section_id, house_id, has_photo } = query;
    const auditType =
      query.audit_type ||
      (query.is_abnormal === '1' || query.is_abnormal === 'true' ? 'abnormal' : null);

    if (class_id || section_id || house_id || auditType) return null;
    if ((user?.allowedClassIds?.length ?? 0) > 0) return null;

    const where: Prisma.unconfirmed_admissionsWhereInput = {};
    const and: Prisma.unconfirmed_admissionsWhereInput[] = [];

    if (search) {
      const isNumeric = /^\d+$/.test(search);
      where.OR = [
        { full_name: { contains: search, mode: 'insensitive' } },
        ...(isNumeric ? [{ id: Number(search) }] : []),
      ];
    }

    const scopedCampus = user?.campusId ?? campus_id;
    if (scopedCampus != null) where.campus_id = scopedCampus;

    if (has_photo === 'true') {
      and.push({ photograph_url: { not: null } }, { photograph_url: { not: '' } });
    } else if (has_photo === 'false') {
      and.push({ OR: [{ photograph_url: null }, { photograph_url: '' }] });
    }
    if (and.length) where.AND = and;

    return where;
  }

  /** Maps a leftover unconfirmed_admissions row into the student list item shape. */
  private mapUnconfirmedItem(u: any) {
    const guardians = Array.isArray(u.guardians) ? u.guardians : [];
    const primary = guardians[0] || null;
    const core = {
      cc: u.id,
      full_name: u.full_name,
      cc_number: u.id,
      gr_number: null,
      cnic: null,
      campus_name: u.campuses?.campus_name ?? null,
      campus_code: u.campuses?.campus_code ?? null,
      class_description: u.requested_grade ?? null,
      class_code: null,
      section_description: null,
      house_name: null,
      house_color: null,
      enrollment_status: 'QUICK_ADMISSION',
      class_id: null,
      photograph_url: u.photograph_url ?? null,
      academic_system: u.academic_system ?? null,
      requested_grade: u.requested_grade ?? null,
      primary_guardian_name: primary?.name ?? null,
      guardian_relationship: primary?.relation ?? null,
      primary_guardian_cnic: primary?.cnic ?? null,
    };
    return {
      id: u.id,
      cc: u.id,
      core,
      student_full_name: core.full_name,
      gr_number: null,
      cc_number: u.id,
      cnic: null,
      campus: core.campus_name,
      class_id: null,
      grade_and_section: u.requested_grade ?? null,
      primary_guardian_name: core.primary_guardian_name,
      whatsapp_number: null,
      enrollment_status: 'QUICK_ADMISSION',
      financial_status_badge: 'NO_SCHEDULE',
      family_id: null,
      household_name: null,
      primary_guardian_cnic: core.primary_guardian_cnic,
      date_of_birth: u.date_of_birth,
      registration_number: u.id,
      residential_address: u.address ?? null,
      siblings: [],
      source: 'unconfirmed_admission',
    };
  }

  async findAll(query: GetStudentsDto, user?: IJwtStaffPayload) {
    const { page = 1, limit = 10, fields } = query;
    const offset = calculateOffset(page, limit);

    // Alias UNCONFIRMED → QUICK_ADMISSION for the students query
    const statusFilter = query.status;
    const quickOnly =
      statusFilter === 'UNCONFIRMED' || statusFilter === StudentStatus.QUICK_ADMISSION;

    const where = await this.buildStudentsWhere(query, user);

    // Remaining unconfirmed rows (collision leftovers / pre-migration) — dual-read
    const uncWhere =
      !statusFilter || quickOnly
        ? this.buildLeftoverUnconfirmedWhere(query, user)
        : null;
    const uncInclude = { campuses: { select: { campus_name: true, campus_code: true } } };

    if (quickOnly) {
      // QUICK_ADMISSION students + leftover unconfirmed rows
      const [studentsTotal, uncTotal] = await Promise.all([
        this.prisma.students.count({ where }),
        uncWhere
          ? this.prisma.unconfirmed_admissions.count({ where: uncWhere })
          : Promise.resolve(0),
      ]);
      const total = studentsTotal + uncTotal;

      let leftoverItems: any[] = [];
      let studentsSkip = offset;
      let studentsTake = limit;

      if (uncTotal > 0 && uncWhere) {
        if (offset < uncTotal) {
          const uncTake = Math.min(limit, uncTotal - offset);
          const uncData = await this.prisma.unconfirmed_admissions.findMany({
            where: uncWhere,
            include: uncInclude,
            orderBy: { id: 'desc' },
            skip: offset,
            take: uncTake,
          });
          leftoverItems = uncData.map((u) => this.mapUnconfirmedItem(u));
          studentsSkip = 0;
          studentsTake = limit - uncTake;
        } else {
          studentsSkip = offset - uncTotal;
        }
      }

      const studentsData =
        studentsTake > 0
          ? await this.prisma.students.findMany({
              where,
              skip: studentsSkip,
              take: studentsTake,
              orderBy: { cc: 'desc' },
              include: {
                campuses: { select: { campus_name: true, campus_code: true } },
                classes: { select: { description: true, class_code: true } },
                sections: { select: { description: true } },
                houses: { select: { house_name: true, house_color: true } },
                student_admissions: { orderBy: { application_date: 'desc' }, take: 1 },
                student_guardians: {
                  include: { guardians: true },
                  orderBy: { guardian_id: 'asc' },
                },
              },
            })
          : [];

      const mappedStudents = studentsData.map((s: any) => {
        const primary = s.student_guardians?.[0];
        const adm = s.student_admissions?.[0];
        const meta = (s.quick_admission_meta as any) || {};
        return {
          id: s.cc,
          cc: s.cc,
          core: {
            cc: s.cc,
            full_name: s.full_name,
            cc_number: s.cc,
            gr_number: s.gr_number,
            cnic: s.cnic,
            campus_name: s.campuses?.campus_name ?? null,
            campus_code: s.campuses?.campus_code ?? null,
            class_description: s.classes?.description ?? adm?.requested_grade ?? null,
            class_code: s.classes?.class_code ?? null,
            section_description: s.sections?.description ?? null,
            house_name: s.houses?.house_name ?? null,
            house_color: s.houses?.house_color ?? null,
            enrollment_status: s.status,
            class_id: s.class_id,
            photograph_url: s.photograph_url ?? null,
            academic_system: adm?.academic_system ?? null,
            requested_grade: adm?.requested_grade ?? null,
            primary_guardian_name: primary?.guardians?.full_name ?? null,
            guardian_relationship: primary?.relationship ?? null,
            primary_guardian_cnic: primary?.guardians?.cnic ?? null,
          },
          student_full_name: s.full_name,
          gr_number: s.gr_number,
          cc_number: s.cc,
          cnic: s.cnic,
          campus: s.campuses?.campus_name ?? null,
          class_id: s.class_id,
          grade_and_section: adm?.requested_grade ?? null,
          primary_guardian_name: primary?.guardians?.full_name ?? null,
          whatsapp_number: null,
          enrollment_status: s.status,
          financial_status_badge: 'NO_SCHEDULE',
          family_id: s.family_id,
          household_name: null,
          primary_guardian_cnic: primary?.guardians?.cnic ?? null,
          date_of_birth: s.dob,
          registration_number: s.cc,
          residential_address: meta.address ?? null,
          siblings: [],
          source: 'quick_admission',
        };
      });

      return {
        items: [...leftoverItems, ...mappedStudents],
        meta: createPaginationMeta(page, limit, total),
      };
    }

    // Determine what relations to include based on user's selected fields
    // If fields is undefined, we return ALL categories by default.
    const requestedFields = fields && fields.length > 0
      ? new Set(fields)
      : new Set(['core', 'academic', 'family', 'contact', 'demographic', 'medical', 'history']);

    // Build the dynamic 'select' object
    const selectArgs: Prisma.studentsSelect = {
      // Base keys required for internal operations
      cc: true,
    };

    if (requestedFields.has('core')) {
      selectArgs.full_name = true;
      selectArgs.gr_number = true;
      selectArgs.cnic = true;
      selectArgs.class_id  = true;
      selectArgs.section_id = true;
      selectArgs.house_id  = true;
      selectArgs.status = true;
      selectArgs.photograph_url = true;
      selectArgs.is_complementary = true;
      selectArgs.is_fee_endowment = true;
      selectArgs.fee_start_term = true;
      selectArgs.campuses  = { select: { campus_name: true, campus_code: true } };
      selectArgs.classes   = { select: { description: true, class_code: true } };
      selectArgs.graduated_from_class = { select: { id: true, description: true, class_code: true } };
      selectArgs.sections  = { select: { description: true } };
      selectArgs.houses    = { select: { house_name: true, house_color: true } };
      selectArgs.family_id = true;
      selectArgs.families  = {
        include: {
          students: {
            where: { deleted_at: null },
            include: { student_guardians: { include: { guardians: true }, take: 1 } }
          }
        }
      };
      selectArgs.student_admissions = {
        orderBy: { application_date: 'desc' },
        take: 1,
        select: {
          requested_grade: true,
          academic_system: true,
          academic_year: true,
          application_date: true,
        },
      };
    }

    if (requestedFields.has('academic')) {
      selectArgs.admission_age_years = true;
      selectArgs.student_admissions = {
        orderBy: { application_date: 'desc' },
        take: 1,
        select: {
          requested_grade: true,
          academic_system: true,
          academic_year: true,
          application_date: true,
        },
      };
    }

    if (requestedFields.has('family')) {
      selectArgs.family_id = true;
      selectArgs.families = {
        select: {
          legacy_pid: true,
          household_name: true,
          primary_address: true,
          students: {
            where: { deleted_at: null },
            select: this.familySiblingSelect,
          },
          _count: { select: { students: true } } // For sibling_count
        },
      };
    }

    if (requestedFields.has('core') || requestedFields.has('contact') || requestedFields.has('medical')) {
      selectArgs.student_guardians = {
        select: {
          is_primary_contact: true,
          is_emergency_contact: true,
          relationship: true,
          guardians: {
            select: {
              full_name: true,
              cnic: true,
              whatsapp_number: true,
              primary_phone: true,
              occupation: true,
            },
          },
        },
      };
    }

    if (requestedFields.has('contact')) {
      selectArgs.primary_phone = true;
      selectArgs.whatsapp_number = true;
    }

    if (requestedFields.has('demographic')) {
      selectArgs.dob = true;
      selectArgs.gender = true;
      selectArgs.nationality = true;
      selectArgs.religion = true;
      selectArgs.email = true;
    }

    if (requestedFields.has('medical')) {
      selectArgs.medical_info = true;
      selectArgs.physical_impairment = true;
      selectArgs.identification_marks = true;
    }

    if (requestedFields.has('history')) {
      selectArgs.student_previous_schools = {
        take: 1,
        orderBy: { id: 'desc' },
        select: {
          school_name: true,
          reason_for_leaving: true,
        },
      };
      selectArgs.student_activities = {
        select: {
          activity_name: true,
          honors_awards: true,
        },
      };
    }

    // Unconfirmed rows (if any) sort first since they carry the highest CCs.
    // Work out how this page splits between unconfirmed and real students.
    const uncTotal = uncWhere
      ? await this.prisma.unconfirmed_admissions.count({ where: uncWhere })
      : 0;
    const studentsTotal = await this.prisma.students.count({ where });
    const total = studentsTotal + uncTotal;

    let unconfirmedItemsForPage: any[] = [];
    let studentsSkip = offset;
    let studentsTake = limit;

    if (uncTotal > 0 && uncWhere) {
      if (offset < uncTotal) {
        const uncTake = Math.min(limit, uncTotal - offset);
        const uncData = await this.prisma.unconfirmed_admissions.findMany({
          where: uncWhere,
          include: uncInclude,
          orderBy: { id: 'desc' },
          skip: offset,
          take: uncTake,
        });
        unconfirmedItemsForPage = uncData.map((u) => this.mapUnconfirmedItem(u));
        studentsSkip = 0;
        studentsTake = limit - uncTake;
      } else {
        studentsSkip = offset - uncTotal;
        studentsTake = limit;
      }
    }

    const studentsData =
      studentsTake > 0
        ? await this.prisma.students.findMany({
            where,
            skip: studentsSkip,
            take: studentsTake,
            orderBy: { cc: 'desc' },
            select: Object.keys(selectArgs).length > 1 ? selectArgs : { cc: true },
          })
        : [];

    // ── Batch Financial Status (NEW) ────────────────────────────────────────
    // To avoid N+1 queries when populating financial badges for the list view,
    // we fetch relevant data for all students in the current page upfront.
    const studentIds = studentsData.map(s => s.cc);
    const financialBadges = new Map<number, string>();

    if (studentIds.length > 0) {
      const now = new Date();
      now.setHours(0, 0, 0, 0);
      const allFees = await this.prisma.student_fees.findMany({
        where: { student_id: { in: studentIds } },
        select: { student_id: true, amount: true, amount_paid: true, due_date: true }
      });

      // Group fees by student
      const feesByStudent = new Map<number, typeof allFees>();
      for (const fee of allFees) {
        if (!feesByStudent.has(fee.student_id)) feesByStudent.set(fee.student_id, []);
        feesByStudent.get(fee.student_id)!.push(fee);
      }

      for (const sid of studentIds) {
        const studentFees = feesByStudent.get(sid) || [];
        if (studentFees.length === 0) {
          financialBadges.set(sid, 'NO_SCHEDULE');
          continue;
        }

        let outstanding = new Prisma.Decimal(0);
        let anyOverdue = false;
        let anyPartial = false;

        for (const fee of studentFees) {
          const balance = new Prisma.Decimal(fee.amount || 0).sub(fee.amount_paid || 0);
          if (balance.gt(0)) {
            outstanding = outstanding.add(balance);
            if (fee.due_date && fee.due_date < now) anyOverdue = true;
            if (new Prisma.Decimal(fee.amount_paid || 0).gt(0)) anyPartial = true;
          }
        }

        let badge = 'Cleared';
        if (anyOverdue) badge = 'Overdue';
        else if (outstanding.gt(0)) badge = 'Partial';

        financialBadges.set(sid, badge);
      }
    }

    // Map and flatten response structure
    const mappedItems = studentsData.map((s: any) => {
      let primaryGuardianNode: any = null;
      let emergencyGuardianNode: any = null;

      if (s.student_guardians) {
        primaryGuardianNode = s.student_guardians.find((g: any) => g.is_primary_contact !== false);
        emergencyGuardianNode = s.student_guardians.find((g: any) => g.is_emergency_contact === true);
        if (!primaryGuardianNode && s.student_guardians.length > 0) primaryGuardianNode = s.student_guardians[0];
      }

      if (!primaryGuardianNode && s.family_id && s.families?.students) {
        const siblingWithGuardian = s.families.students.find((sib: any) => sib.cc !== s.cc && sib.student_guardians?.length > 0);
        if (siblingWithGuardian) primaryGuardianNode = siblingWithGuardian.student_guardians[0];
      }

      const primaryGuardian = primaryGuardianNode?.guardians;
      const emergencyGuardian = emergencyGuardianNode?.guardians;
      const latestAdmission = s.student_admissions?.[0] || null;
      const previousSchool = s.student_previous_schools?.[0] || null;

      const mappedData: any = { id: s.cc, cc: s.cc };

      if (requestedFields.has('core')) {
        mappedData.core = {
          cc: s.cc,
          full_name: s.full_name,
          cc_number: s.cc,
          gr_number: s.gr_number,
          cnic: s.cnic,
          campus_name: s.campuses?.campus_name,
          campus_code: s.campuses?.campus_code,
          class_description: s.classes?.description,
          class_code: s.classes?.class_code,
          section_description: s.sections?.description,
          house_name: s.houses?.house_name,
          house_color: s.houses?.house_color,
          enrollment_status: s.status,
          class_id: s.class_id,
          photograph_url: s.photograph_url,
          academic_system: latestAdmission?.academic_system,
          requested_grade: latestAdmission?.requested_grade,
          primary_guardian_name: primaryGuardianNode?.guardians?.full_name,
          guardian_relationship: primaryGuardianNode?.relationship,
          primary_guardian_cnic: primaryGuardianNode?.guardians?.cnic,
        };
      }

      if (requestedFields.has('academic')) {
        mappedData.academic = {
          academic_system: latestAdmission?.academic_system,
          requested_grade: latestAdmission?.requested_grade,
          academic_year: latestAdmission?.academic_year,
          application_date: latestAdmission?.application_date,
          admission_age_years: s.admission_age_years,
        };
      }

      if (requestedFields.has('family')) {
        mappedData.family = {
          family_id: s.family_id,
          legacy_pid: s.families?.legacy_pid,
          household_name: s.families?.household_name,
          primary_address: s.families?.primary_address,
          sibling_count: s.families?._count?.students,
          siblings: s.families?.students
            ?.filter((sib: any) => sib.cc !== s.cc)
            ?.map((sib: any) => this.mapSiblingForResponse(sib)),
        };
      }

      if (requestedFields.has('contact')) {
        mappedData.contact = {
          primary_guardian_name: primaryGuardian?.full_name,
          guardian_relationship: primaryGuardianNode?.relationship,
          whatsapp_number: primaryGuardian?.whatsapp_number || s.whatsapp_number,
          primary_phone: primaryGuardian?.primary_phone || s.primary_phone,
          guardian_cnic: primaryGuardian?.cnic,
          guardian_occupation: primaryGuardian?.occupation,
        };
      }

      if (requestedFields.has('demographic')) {
        mappedData.demographic = {
          dob: s.dob,
          gender: s.gender,
          nationality: s.nationality,
          religion: s.religion,
          email: s.email,
        };
      }

      if (requestedFields.has('medical')) {
        mappedData.medical = {
          medical_info: s.medical_info,
          physical_impairment: s.physical_impairment,
          identification_marks: s.identification_marks,
          emergency_contact_info: emergencyGuardian ? {
            name: emergencyGuardian.full_name,
            phone: emergencyGuardian.primary_phone || emergencyGuardian.whatsapp_number,
          } : null,
        };
      }

      if (requestedFields.has('history')) {
        mappedData.history = {
          previous_school_name: previousSchool?.school_name,
          reason_for_leaving: previousSchool?.reason_for_leaving,
          student_activities: s.student_activities || [],
        };
      }

      return {
        ...mappedData,
        student_full_name: mappedData.core?.full_name,
        gr_number: mappedData.core?.gr_number,
        cc_number: mappedData.core?.cc_number,
        cnic: mappedData.core?.cnic,
        campus: mappedData.core?.campus_name,
        class_id: s.class_id,
        grade_and_section: mappedData.core?.class_description
          ? `${mappedData.core.class_description}${mappedData.core.section_description ? ` (${mappedData.core.section_description})` : ''}`
          : mappedData.academic?.requested_grade,
        primary_guardian_name: mappedData.contact?.primary_guardian_name,
        whatsapp_number: mappedData.contact?.whatsapp_number,
        enrollment_status: mappedData.core?.enrollment_status,
        financial_status_badge: financialBadges.get(s.cc) || 'NO_SCHEDULE',
        family_id: mappedData.family?.family_id,
        household_name: mappedData.family?.household_name,
        primary_guardian_cnic: mappedData.contact?.guardian_cnic,
        date_of_birth: mappedData.demographic?.dob,
        registration_number: mappedData.core?.cc_number,
        residential_address: mappedData.family?.primary_address,
        siblings: mappedData.family?.siblings,
      };
    });

    const meta = createPaginationMeta(page, limit, total);

    // Unconfirmed records lead the page (highest CCs first), then real students.
    return { items: [...unconfirmedItemsForPage, ...mappedItems], meta };
  }

  async exportExcel(query: GetStudentsDto, user?: IJwtStaffPayload): Promise<Buffer> {
    const where = await this.buildStudentsWhere(query, user);
    const count = await this.prisma.students.count({ where });
    if (count > 10000) {
      throw new BadRequestException('Export limit exceeded. Please apply filters to limit search to under 10,000 students.');
    }

    const students = await this.prisma.students.findMany({
      where,
      orderBy: { cc: 'desc' },
      select: {
        cc: true,
        full_name: true,
        gr_number: true,
        gender: true,
        cnic: true,
        dob: true,
        status: true,
        academic_year: true,
        is_complementary: true,
        is_fee_endowment: true,
        fee_start_term: true,
        primary_phone: true,
        whatsapp_number: true,
        families: {
          select: {
            primary_address: true,
            students: {
              where: { deleted_at: null },
              select: { cc: true }
            }
          }
        },
        campuses: { select: { campus_name: true } },
        classes: { select: { description: true } },
        sections: { select: { description: true } },
        houses: { select: { house_name: true } },
        student_guardians: {
          select: {
            relationship: true,
            is_emergency_contact: true,
            guardians: {
              select: {
                full_name: true,
                cnic: true,
                primary_phone: true,
                whatsapp_number: true,
              }
            }
          }
        },
        student_admissions: {
          orderBy: { application_date: 'desc' },
          take: 1,
          select: {
            academic_year: true,
          }
        }
      }
    });

    const isFather = (rel: string) => {
      const r = (rel || '').trim().toUpperCase();
      return r === 'FATHER' || (r.includes('FATHER') && !r.includes('GRAND'));
    };

    const isMother = (rel: string) => {
      const r = (rel || '').trim().toUpperCase();
      return r === 'MOTHER' || (r.includes('MOTHER') && !r.includes('GRAND'));
    };

    const formatDob = (dob: Date | null) => {
      if (!dob) return '';
      const d = new Date(dob);
      if (isNaN(d.getTime())) return '';
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };

    // Columns config mapping
    const columnsConfig: Record<string, { header: string; width: number; getValue: (s: any) => any }> = {
      // Student columns
      student_name: { header: 'Student Name', width: 25, getValue: (s) => s.full_name || '' },
      cc: { header: 'CC', width: 10, getValue: (s) => s.cc },
      gr: { header: 'GR', width: 10, getValue: (s) => s.gr_number || '' },
      cnic: { header: 'Student CNIC', width: 20, getValue: (s) => s.cnic || '' },
      dob: { header: 'Date of Birth', width: 15, getValue: (s) => formatDob(s.dob) },
      gender: { header: 'Gender', width: 12, getValue: (s) => s.gender || '' },
      branch: { header: 'Branch', width: 20, getValue: (s) => s.campuses?.campus_name || '' },
      class: { header: 'Class', width: 15, getValue: (s) => s.classes?.description || '' },
      section: { header: 'Section', width: 12, getValue: (s) => s.sections?.description || '' },
      house: { header: 'House', width: 15, getValue: (s) => s.houses?.house_name || '' },
      status: { header: 'Status', width: 15, getValue: (s) => s.status || '' },
      academic_year: { header: 'Academic Year', width: 15, getValue: (s) => s.academic_year || s.student_admissions?.[0]?.academic_year || '' },
      is_complementary: { header: 'Is Complementary', width: 18, getValue: (s) => s.is_complementary ? 'Yes' : 'No' },
      is_fee_endowment: { header: 'Is Fee Endowment', width: 18, getValue: (s) => s.is_fee_endowment ? 'Yes' : 'No' },
      fee_start_term: { header: 'Fee Start Term', width: 15, getValue: (s) => s.fee_start_term || '' },
      residential_address: { header: 'Residential Address', width: 35, getValue: (s) => s.families?.primary_address || '' },
      sibling_count: { header: 'Sibling Count', width: 15, getValue: (s) => s.families?.students ? Math.max(0, s.families.students.length - 1) : 0 },
      primary_phone: { header: 'Primary Phone', width: 20, getValue: (s) => s.primary_phone || '' },
      whatsapp_number: { header: 'WhatsApp Number', width: 20, getValue: (s) => s.whatsapp_number || '' },

      // Parent columns
      father_name: { header: 'Father Name', width: 25, getValue: (s) => s.student_guardians.find((g: any) => isFather(g.relationship))?.guardians?.full_name || '' },
      father_cnic: { header: 'Father CNIC', width: 20, getValue: (s) => s.student_guardians.find((g: any) => isFather(g.relationship))?.guardians?.cnic || '' },
      father_phone: { header: 'Father Phone', width: 20, getValue: (s) => s.student_guardians.find((g: any) => isFather(g.relationship))?.guardians?.primary_phone || s.student_guardians.find((g: any) => isFather(g.relationship))?.guardians?.whatsapp_number || '' },
      mother_name: { header: 'Mother Name', width: 25, getValue: (s) => s.student_guardians.find((g: any) => isMother(g.relationship))?.guardians?.full_name || '' },
      mother_cnic: { header: 'Mother CNIC', width: 20, getValue: (s) => s.student_guardians.find((g: any) => isMother(g.relationship))?.guardians?.cnic || '' },
      mother_phone: { header: 'Mother Phone', width: 20, getValue: (s) => s.student_guardians.find((g: any) => isMother(g.relationship))?.guardians?.primary_phone || s.student_guardians.find((g: any) => isMother(g.relationship))?.guardians?.whatsapp_number || '' },
      emergency_contact_name: { header: 'Emergency Contact Name', width: 25, getValue: (s) => s.student_guardians.find((g: any) => g.is_emergency_contact === true)?.guardians?.full_name || '' },
      emergency_contact_phone: { header: 'Emergency Contact Phone', width: 20, getValue: (s) => s.student_guardians.find((g: any) => g.is_emergency_contact === true)?.guardians?.primary_phone || s.student_guardians.find((g: any) => g.is_emergency_contact === true)?.guardians?.whatsapp_number || '' },
    };

    // Determine columns to export
    const requestedColumns = query.columns ? query.columns.split(',') : [];
    const columnsToExport = requestedColumns.length > 0 
      ? requestedColumns.filter(col => columnsConfig[col]) 
      : ['student_name', 'father_name', 'mother_name', 'cc', 'gr', 'branch', 'class', 'section', 'gender', 'cnic', 'academic_year', 'dob', 'status'];

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Students');

    // Define worksheet columns
    worksheet.columns = columnsToExport.map(col => ({
      header: columnsConfig[col].header,
      key: col,
      width: columnsConfig[col].width
    }));

    // Style the header row
    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1E3A8A' } // Dark blue theme
    };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
    headerRow.height = 25;

    for (const student of students) {
      const rowData: Record<string, any> = {};
      for (const col of columnsToExport) {
        rowData[col] = columnsConfig[col].getValue(student);
      }
      worksheet.addRow(rowData);
    }

    // Auto-fit column widths
    worksheet.columns.forEach((column) => {
      if (!column || typeof column.eachCell !== 'function') return;
      let maxLen = 0;
      column.eachCell({ includeEmpty: true }, (cell) => {
        const val = cell.value ? String(cell.value) : '';
        if (val.length > maxLen) {
          maxLen = val.length;
        }
      });
      column.width = Math.max(maxLen + 4, 10);
    });

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  async findOne(id: number) {
    const s = await this.prisma.students.findFirst({
      where: { cc: id, deleted_at: null },
      include: {
        campuses: true,
        families: {
          include: {
            students: {
              where: { deleted_at: null },
              select: {
                cc: true,
                full_name: true,
                gr_number: true,
                status: true,
                classes: { select: { description: true, class_code: true } },
                sections: { select: { description: true } },
                student_admissions: {
                  orderBy: { application_date: "desc" },
                  take: 1,
                  select: { requested_grade: true },
                },
                student_guardians: {
                  where: { is_primary_contact: true },
                  take: 1,
                  select: { guardians: { select: { full_name: true } } }
                }
              }
            },
            _count: { select: { students: true } }
          }
        },
        classes: true,
        sections: true,
        student_admissions: { orderBy: { application_date: 'desc' }, take: 1 },
        student_guardians: {
          include: { guardians: true }
        },
         student_previous_schools: { orderBy: { id: 'desc' }, take: 1 },
        student_activities: true,
        student_flags: { orderBy: { reminder_date: 'desc' } },
        graduated_from_class: true,
      }
    });

    if (!s) throw new NotFoundException(`Student #${id} not found`);

    // Inheritance fallback for guardians
    if (s.student_guardians.length === 0 && s.family_id) {
       const inherited = await this.prisma.student_guardians.findMany({
         where: { students: { family_id: s.family_id } },
         include: { guardians: true },
         orderBy: { guardian_id: 'asc' }
       });
       const seen = new Set();
       s.student_guardians = inherited.filter(link => {
         if (seen.has(link.guardian_id)) return false;
         seen.add(link.guardian_id);
         return true;
       });
    }

    const primaryGuardianNode = s.student_guardians.find((g: any) => g.is_primary_contact === true) || s.student_guardians[0];
    const primaryGuardian = primaryGuardianNode?.guardians;
    const fatherNode = s.student_guardians.find((g: any) => g.relationship === 'FATHER') || primaryGuardianNode;

    const financial = await this.getFinancialDigest(s.cc);

    let resolvedClassId = s.class_id;
    if (!resolvedClassId && s.status === 'SOFT_ADMISSION') {
      const requestedGrade = s.student_admissions?.[0]?.requested_grade;
      if (requestedGrade) {
        const normalized = requestedGrade.replace(/[-\s]/g, '').toUpperCase();
        const matchedClass = await this.prisma.classes.findFirst({
          where: {
            OR: [
              { class_code: requestedGrade },
              { class_code: normalized },
              { description: requestedGrade },
            ],
          },
          select: { id: true }
        });
        resolvedClassId = matchedClass?.id ?? null;
      }
    }

    // ── Backfill graduated_from_class_id for legacy graduated students ───────
    if (s.status === 'GRADUATED' && !s.graduated_from_class_id) {
      const admission = s.student_admissions?.[0];
      let resolvedGradClass: { id: number; description: string; class_code: string } | null = null;

      if (admission?.requested_grade) {
        const grade = admission.requested_grade;
        const normalized = grade.replace(/[-\s]/g, '').toUpperCase();
        resolvedGradClass = await this.prisma.classes.findFirst({
          where: {
            OR: [
              { class_code: { equals: grade, mode: 'insensitive' } },
              { class_code: { equals: normalized, mode: 'insensitive' } },
              { description: { equals: grade, mode: 'insensitive' } },
              { description: { contains: grade, mode: 'insensitive' } },
            ],
          },
          select: { id: true, description: true, class_code: true },
        }) as any;
      }

      if (resolvedGradClass) {
        // Persist it so subsequent loads are instant
        await this.prisma.students.update({
          where: { cc: s.cc },
          data: { graduated_from_class_id: resolvedGradClass.id },
        }).catch(() => { /* non-critical, ignore */ });
        (s as any).graduated_from_class_id = resolvedGradClass.id;
        (s as any).graduated_from_class = resolvedGradClass;
      }
    }

    // ── Potential Family Detection (for unlinked students) ───────────────────
    let potentialFamilyMatch: any = null;
    if (!s.family_id) {
        // Look for families where father or mother are already linked to other students
        const guardianCnics = s.student_guardians
            .map(sg => sg.guardians.cnic)
            .filter(Boolean);

        if (guardianCnics.length > 0) {
            const siblingLink = await this.prisma.student_guardians.findFirst({
                where: {
                    guardian_id: { in: s.student_guardians.map(sg => sg.guardian_id) },
                    student_id: { not: s.cc },
                    students: { family_id: { not: null } }
                },
                include: {
                    students: {
                        include: {
                            families: true,
                            student_guardians: {
                                where: { relationship: 'MOTHER' },
                                include: { guardians: true }
                            }
                        }
                    }
                }
            });

            if (siblingLink && siblingLink.students && siblingLink.students.families) {
                const fam = siblingLink.students.families;
                const mother = siblingLink.students.student_guardians.find(sg => sg.relationship === 'MOTHER')?.guardians;
                potentialFamilyMatch = {
                    id: fam.id,
                    household_name: fam.household_name,
                    spouse_name: mother?.full_name,
                    spouse_cnic: mother?.cnic,
                };
            }
        }
    }

    return {
      id: s.cc,
      cc: s.cc,
      student_full_name: s.full_name,
      gr_number: s.gr_number,
      cc_number: s.cc,
      cnic: s.cnic,
      campus: s.campuses?.campus_name,
      campus_code: s.campuses?.campus_code,
      campus_id: s.campus_id,
      class_id: resolvedClassId,
      section_id: s.section_id,
      grade_and_section: s.classes
        ? `${s.classes.description}${s.sections ? ` (${s.sections.description})` : ''}`
        : s.student_admissions?.[0]?.requested_grade,
      enrollment_status: s.status,
      is_complementary: s.is_complementary,
      is_fee_endowment: s.is_fee_endowment,
      fee_start_term: s.fee_start_term,
      graduated_from_class_id: s.graduated_from_class_id,
      graduated_from_class: s.graduated_from_class,
      financial_status_badge: financial.badge,
      total_outstanding_balance: financial.outstanding,
      advance_credit_balance: financial.advance,
      family_id: s.family_id,
      household_name: s.families?.household_name,
      potential_family_match: potentialFamilyMatch,
      primary_guardian_name: primaryGuardian?.full_name,
      primary_guardian_cnic: primaryGuardian?.cnic,
      whatsapp_number: primaryGuardian?.whatsapp_number || s.whatsapp_number,
      primary_phone: primaryGuardian?.primary_phone || s.primary_phone,
      home_phone: s.families?.home_phone || s.home_phone,
      date_of_birth: s.dob,
      gender: s.gender,
      registration_number: s.cc,
      father_name: fatherNode?.guardians?.full_name || primaryGuardian?.full_name,
      residential_address: s.families?.primary_address || (() => {
        const g = primaryGuardian;
        if (!g) return null;
        return [
          g.house_appt_number,
          g.house_appt_name,
          g.area_block,
          g.city,
          g.province,
          g.country
        ].filter(Boolean).join(', ') || null;
      })(),
      photograph_url: s.photograph_url,
      photo_blue_bg_url: s.photo_blue_bg_url,
      date_of_admission: s.doa,
      academic_year: s.academic_year,
      families: s.families ? {
        household_name: s.families.household_name,
        legacy_pid: s.families.legacy_pid,
        home_phone: s.families.home_phone,
      } : null,
      siblings: s.families?.students
        ?.filter((sib: any) => sib.cc !== s.cc)
        ?.map((sib: any) => this.mapSiblingForResponse(sib)),
      action_logs: s.student_flags.map((f: any) => {
        // Derive a clean type from the flag key (e.g. "GRADUATED_LOG_1234" → "GRADUATED")
        const rawType = f.flag
          .replace(/_LOG_\d+$/, '')   // strip timestamped suffix
          .replace(/_LOG$/, '');       // strip plain _LOG suffix
        const titleMap: Record<string, string> = {
          ENROLLED:       'Enrolled',
          QUICK_ADMISSION: 'Quick Admission',
          SOFT_ADMISSION: 'Soft Admission',
          LEFT:           'Marked as Left',
          UNDO_LEFT:      'Left Status Reversed',
          EXPELLED:       'Expelled',
          UNEXPELLED:     'Expulsion Reversed',
          GRADUATED:      'Graduated',
        };
        return {
          id:          String(f.id),
          type:        rawType,
          title:       titleMap[rawType] ?? rawType.replace(/_/g, ' '),
          description: f.comment ?? null,
          occurred_at: f.reminder_date?.toISOString() ?? f.created_at?.toISOString() ?? null,
        };
      }),
    };

  }

  async assignStudent(id: number, dto: any, changedBy: string) {
    const student = await this.prisma.students.findUnique({
        where: { cc: id },
    });

    if (!student || student.deleted_at) {
        throw new NotFoundException(`Student #${id} not found`);
    }

    const nextCampusId = dto.campus_id !== undefined ? dto.campus_id : student.campus_id;
    const nextClassId = dto.class_id !== undefined ? dto.class_id : student.class_id;
    const nextSectionId = dto.section_id !== undefined ? dto.section_id : student.section_id;
    const nextHouseId = dto.house_id !== undefined ? dto.house_id : student.house_id;
    const countsTowardCapacity = student.status === StudentStatus.ENROLLED;

    const runUpdate = async (tx: any) => {
      if (
        this.allocation.shouldValidatePlacement({
          campusId: nextCampusId,
          classId: nextClassId,
          sectionId: nextSectionId,
        })
      ) {
        await this.allocation.assertPlacementAllowed(
          {
            campusId: nextCampusId,
            classId: nextClassId,
            sectionId: nextSectionId,
          },
          {
            studentCc: id,
            gender: student.gender,
            countsTowardCapacity,
          },
          tx,
        );
      }

      const updated = await tx.students.update({
        where: { cc: id },
        data: {
          campus_id: dto.campus_id !== undefined ? dto.campus_id : undefined,
          class_id: dto.class_id !== undefined ? dto.class_id : undefined,
          section_id: dto.section_id !== undefined ? dto.section_id : undefined,
          house_id: dto.house_id !== undefined ? dto.house_id : undefined,
        },
        include: this.assignmentInclude,
      });

      const changeType = this.progressionHistory.resolveChangeType({
        prior: {
          campus_id: student.campus_id,
          class_id: student.class_id,
          section_id: student.section_id,
          house_id: student.house_id,
        },
        next: {
          campusId: nextCampusId,
          classId: nextClassId,
          sectionId: nextSectionId,
          houseId: nextHouseId,
        },
        defaultType: 'REASSIGNED',
      });

      await this.progressionHistory.recordProgressionChange(tx, {
        studentCc: id,
        campusId: nextCampusId,
        classId: nextClassId,
        sectionId: nextSectionId,
        houseId: nextHouseId,
        academicYear: student.academic_year,
        grNumber: student.gr_number,
        changeType,
        changedBy,
      });

      return updated;
    };

    if (
      this.allocation.shouldValidatePlacement({
        campusId: nextCampusId,
        classId: nextClassId,
        sectionId: nextSectionId,
      })
    ) {
      return this.allocation.withSectionLock(
        {
          campusId: nextCampusId,
          classId: nextClassId,
          sectionId: nextSectionId,
        },
        runUpdate,
      );
    }

    return this.prisma.$transaction(async (tx) => runUpdate(tx));
  }

  async unexpelStudent(id: number, changedBy: string) {
    const student = await this.prisma.students.findUnique({
      where: { cc: id },
      select: {
        cc: true,
        status: true,
        deleted_at: true,
      },
    });

    if (!student || student.deleted_at) {
      throw new NotFoundException(`Student #${id} not found`);
    }

    if (student.status !== StudentStatus.EXPELLED) {
      throw new BadRequestException('Only expelled students can be unexpelled');
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.students.update({
        where: { cc: id },
        data: {
          status: StudentStatus.ENROLLED,
        },
        include: this.assignmentInclude,
      });

      await tx.student_flags.updateMany({
        where: {
          student_id: id,
          flag: 'EXPELLED',
          work_done: false,
        },
        data: {
          work_done: true,
        },
      });

      await tx.student_flags.create({
        data: {
          student_id: id,
          flag: `UNEXPELLED_LOG_${Date.now()}`,
          reminder_date: new Date(),
          work_done: true,
          comment: 'Status changed back to Enrolled',
        },
      });

      await this.auditLogs.log({
        entity_type: 'STUDENT',
        entity_id: String(id),
        action: 'STATUS_CHANGED',
        new_value: 'ENROLLED',
        old_value: 'EXPELLED',
        changed_by: changedBy,
        student_id: id,
        note: 'Status unexpelled back to Enrolled',
      });

      return updated;
    });
  }

  async undoLeftStudent(id: number, changedBy: string) {
    const student = await this.prisma.students.findUnique({
      where: { cc: id },
      select: {
        cc: true,
        status: true,
        deleted_at: true,
      },
    });

    if (!student || student.deleted_at) {
      throw new NotFoundException(`Student #${id} not found`);
    }

    if (student.status !== StudentStatus.LEFT) {
      throw new BadRequestException('Only students requested as left can be restored');
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.students.update({
        where: { cc: id },
        data: {
          status: StudentStatus.ENROLLED,
        },
        include: this.assignmentInclude,
      });

      // Mark all LEFT_LOG_ flags as done (new timestamped pattern)
      await tx.student_flags.updateMany({
        where: {
          student_id: id,
          flag: { startsWith: 'LEFT_LOG_' },
          work_done: false,
        },
        data: {
          work_done: true,
        },
      });

      await tx.student_flags.create({
        data: {
          student_id: id,
          flag: `UNDO_LEFT_LOG_${Date.now()}`,
          reminder_date: new Date(),
          work_done: true,
          comment: 'Student status restored to ENROLLED from LEFT',
        },
      });

      await this.auditLogs.log({
        entity_type: 'STUDENT',
        entity_id: String(id),
        action: 'STATUS_CHANGED',
        new_value: 'ENROLLED',
        old_value: 'LEFT',
        changed_by: changedBy,
        student_id: id,
        note: 'Status restored to Enrolled from Left',
      });

      return updated;
    });
  }

  async changeStatus(id: number, newStatus: StudentStatus, reason?: string, changedBy?: string, user?: IJwtStaffPayload) {
    const student = await this.prisma.students.findUnique({
      where: { cc: id },
      select: { cc: true, status: true, deleted_at: true, class_id: true, academic_year: true, campus_id: true },
    });

    if (!student || student.deleted_at) {
      throw new NotFoundException(`Student #${id} not found`);
    }

    if (user && user.campusId != null && student.campus_id !== user.campusId) {
      throw new ForbiddenException('You do not have access to this student\'s campus');
    }

    if ((student.status as any) === newStatus) {
      throw new BadRequestException(`Student is already in ${newStatus} status`);
    }

    // Each status maps to a timestamped flag prefix so every transition is individually logged.
    const flagPrefixMap: Record<StudentStatus, string> = {
      [StudentStatus.QUICK_ADMISSION]: 'QUICK_ADMISSION_LOG',
      [StudentStatus.ENROLLED]:       'ENROLLED_LOG',
      [StudentStatus.SOFT_ADMISSION]: 'SOFT_ADMISSION_LOG',
      [StudentStatus.LEFT]:           'LEFT_LOG',
      [StudentStatus.EXPELLED]:       'EXPELLED_LOG',
      [StudentStatus.GRADUATED]:      'GRADUATED_LOG',
    };

    return this.prisma.$transaction(async (tx) => {
      const updateData: any = { status: newStatus };

      // When graduating, record which class the student graduated from and clear class assignment
      if (newStatus === StudentStatus.GRADUATED) {
        if (student.class_id) {
          updateData.graduated_from_class_id = student.class_id;
        }
        updateData.class_id = null;
        // Auto-increment academic year (e.g. 2023-2024 → 2024-2025)
        updateData.academic_year = this.incrementAcademicYear(student.academic_year);
      }

      const updated = await tx.students.update({
        where: { cc: id },
        data: updateData,
        include: this.assignmentInclude,
      });

      await tx.student_flags.create({
        data: {
          student_id: id,
          flag: `${flagPrefixMap[newStatus]}_${Date.now()}`,
          work_done: true,
          comment: reason?.trim() || null,
          // Always record the exact date/time this action was performed
          reminder_date: new Date(),
        },
      });

      await this.auditLogs.log({
        entity_type: 'STUDENT',
        entity_id: String(id),
        action: 'STATUS_CHANGED',
        new_value: newStatus,
        old_value: student.status,
        changed_by: changedBy || 'system',
        student_id: id,
        note: reason?.trim() || null,
      });

      return updated;
    });
  }

  async getAcademicHistory(cc: number) {
    return this.prisma.student_academic_history.findMany({
      where: { student_cc: cc },
      orderBy: { changed_at: 'asc' },
      include: {
        classes: { select: { description: true, class_code: true } },
        sections: { select: { description: true } },
        campuses: { select: { campus_name: true } },
      },
    });
  }

  async getProgressionPeriods(cc: number) {
    return this.prisma.student_progression_periods.findMany({
      where: { student_cc: cc },
      orderBy: { valid_from: 'asc' },
      include: {
        classes: { select: { description: true, class_code: true } },
        sections: { select: { description: true } },
        campuses: { select: { campus_name: true } },
        houses: { select: { house_name: true, house_color: true } },
      },
    });
  }

  async getHouseHistory(cc: number) {
    const logs = await this.prisma.audit_logs.findMany({
      where: { student_id: cc, entity_type: 'STUDENT', field: 'student.house_id' },
      orderBy: { changed_at: 'asc' },
    });
    if (logs.length === 0) return [];

    const houseIds = new Set<number>();
    for (const log of logs) {
      if (log.old_value) houseIds.add(Number(log.old_value));
      if (log.new_value) houseIds.add(Number(log.new_value));
    }
    const houses = await this.prisma.houses.findMany({
      where: { id: { in: [...houseIds] } },
      select: { id: true, house_name: true, house_color: true },
    });
    const houseMap = new Map(houses.map((h) => [h.id, h]));

    return logs.map((log) => ({
      id: log.id,
      from_house: log.old_value ? houseMap.get(Number(log.old_value)) ?? null : null,
      to_house: log.new_value ? houseMap.get(Number(log.new_value)) ?? null : null,
      changed_by: log.changed_by,
      changed_at: log.changed_at,
      note: log.note,
    }));
  }

  /** Preview next A-Level GR assignments for a promotion batch (same logic as promoteBulk). */
  async suggestGrNumbersForPromotion(studentCcs: number[], isALevel = true): Promise<Record<number, string>> {
    if (!studentCcs.length) return {};

    const students = await this.prisma.students.findMany({
      where: { cc: { in: studentCcs }, deleted_at: null },
      select: { cc: true, campus_id: true },
      orderBy: { cc: 'asc' },
    });

    const byCampus = new Map<number, Array<{ cc: number; campus_id: number }>>();
    for (const s of students) {
      if (!s.campus_id) continue;
      if (!byCampus.has(s.campus_id)) byCampus.set(s.campus_id, []);
      byCampus.get(s.campus_id)!.push({ cc: s.cc, campus_id: s.campus_id });
    }

    const assignments: Record<number, string> = {};
    for (const [, group] of byCampus) {
      const grs = await allocateSequentialGrNumbers(
        this.prisma,
        group[0].campus_id,
        group.length,
        isALevel,
      );
      group.forEach((s, i) => {
        assignments[s.cc] = grs[i];
      });
    }

    return assignments;
  }

  private async assignALevelGrOverridesForPromotion(
    candidates: Array<{ cc: number; campus_id: number | null }>,
    grOverrideMap: Map<number, string>,
    isALevelPromotion: boolean,
  ): Promise<void> {
    if (!isALevelPromotion) return;

    const needing = candidates
      .filter((c) => !grOverrideMap.has(c.cc) && c.campus_id)
      .sort((a, b) => a.cc - b.cc);

    const byCampus = new Map<number, typeof needing>();
    for (const s of needing) {
      const cid = s.campus_id!;
      if (!byCampus.has(cid)) byCampus.set(cid, []);
      byCampus.get(cid)!.push(s);
    }

    for (const [campusId, group] of byCampus) {
      const grs = await allocateSequentialGrNumbers(this.prisma, campusId, group.length, true);
      group.forEach((s, i) => grOverrideMap.set(s.cc, grs[i]));
    }
  }

  async promoteSingle(dto: PromoteSingleStudentDto, changedBy: string) {
    const result = await this.promoteBulk({
      from: dto.from,
      to: dto.to,
      graduate: dto.graduate,
      expel: dto.expel,
      left: dto.left,
      target_academic_year: dto.target_academic_year,
      to_section_id: dto.to_section_id,
      student_ids: [dto.student_id],
      reason: dto.reason,
      dry_run: dto.dry_run,
    }, changedBy);

    return {
      ...result,
      outcome: result.results[0] || null,
    };
  }

  async promoteBulk(dto: PromoteBulkStudentsDto, changedBy: string) {
    // Validate: exactly one of `to`, `graduate`, `expel`, or `left` must be set
    const isGraduating = !!dto.graduate;
    const isExpelling = !!dto.expel;
    const isLeaving = !!dto.left;

    if (!isGraduating && !isExpelling && !isLeaving && !dto.to) {
      throw new BadRequestException('Either `to` (target class), `graduate: true`, `expel: true`, or `left: true` must be provided');
    }
    const actionCount = [!!dto.to, isGraduating, isExpelling, isLeaving].filter(Boolean).length;
    if (actionCount > 1) {
      throw new BadRequestException('Only one of `to`, `graduate`, `expel`, or `left` may be specified at a time');
    }

    // For expel/left/graduate, `from` is optional — we don't move the student between classes.
    const fromIsMissing = dto.from?.class_id == null && !dto.from?.class_label;
    if (!isGraduating && !isExpelling && !isLeaving && fromIsMissing) {
      throw new BadRequestException('`from` selector (class_id or class_label) is required for promotion');
    }
    const fromClass = (isGraduating || isExpelling || isLeaving) && fromIsMissing
      ? null
      : await this.resolveClassSelector(dto.from!, 'from');
    const toClass = isGraduating || isExpelling || isLeaving ? null : await this.resolveClassSelector(dto.to!, 'to');

    if (!isGraduating && !isExpelling && !isLeaving && toClass && fromClass?.id === toClass.id) {
      throw new BadRequestException('From and to class must be different for promotion');
    }

    const dryRun = !!dto.dry_run;
    const distinctStudentIds = dto.student_ids?.length
      ? Array.from(new Set(dto.student_ids))
      : undefined;
    const isExplicitIds = !!(distinctStudentIds && distinctStudentIds.length > 0);

    // Campus, section and source academic_year filters only apply in batch (class-wide) mode.
    // When explicit student_ids are provided, we look up exactly those students by cc —
    // no extra filters, because the user explicitly asked for those IDs. Mismatches
    // (wrong class, wrong campus) are handled gracefully in processPromotionForStudent.
    const where: Prisma.studentsWhereInput = { deleted_at: null };

    if (!isExplicitIds) {
      if (dto.campus_id !== undefined) {
        where.campus_id = dto.campus_id;
      }

      if (dto.section_id !== undefined) {
        where.section_id = dto.section_id;
      }

      // Filter candidates by their current academic year.
      // This is a SOURCE filter — it narrows which students are picked up for promotion.
      // A class can have students from different years (e.g. held-back students from a
      // prior year). Use this to target only those currently in a specific year.
      if (dto.academic_year !== undefined) {
        where.academic_year = dto.academic_year;
      }
    }

    if (isExplicitIds) {
      where.cc = { in: distinctStudentIds };
    } else if (fromClass) {
      where.class_id = fromClass.id;
    }

    const candidates = await this.prisma.students.findMany({
      where,
      select: {
        cc: true,
        full_name: true,
        class_id: true,
        section_id: true,
        campus_id: true,
        house_id: true,
        academic_year: true,
        status: true,
        gr_number: true,
        gender: true,
      },
      orderBy: { cc: 'asc' },
    });

    const classActiveCache = new Map<string, boolean>();
    const sectionActiveCache = new Map<string, boolean>();
    const results: PromotionOutcome[] = [];
    const grOverrideMap = new Map((dto.gr_overrides ?? []).map(o => [o.student_cc, o.new_gr]));

    const isALevelPromotion = !!toClass && this.isALevelAcademicSystem(toClass.academic_system);
    await this.assignALevelGrOverridesForPromotion(candidates, grOverrideMap, isALevelPromotion);

    const CHUNK_SIZE = 25;
    if (isExplicitIds) {
      const byId = new Map(candidates.map((s) => [s.cc, s]));
      const studentIds = distinctStudentIds!;

      for (let i = 0; i < studentIds.length; i += CHUNK_SIZE) {
        const chunk = studentIds.slice(i, i + CHUNK_SIZE);
        await Promise.all(chunk.map(async (studentId) => {
          const student = byId.get(studentId);
          if (!student) {
            results.push({
              student_id: studentId,
              status: 'failed',
              reason_code: 'STUDENT_NOT_FOUND',
              message: 'Student not found or does not match provided filters',
              dry_run: dryRun,
            });
            return;
          }

          const outcome = await this.processPromotionForStudent(
            student,
            fromClass!,
            toClass,
            isGraduating,
            isExpelling,
            isLeaving,
            isExplicitIds,
            dto.to_section_id,
            dto.reason,
            dto.target_academic_year,
            dryRun,
            classActiveCache,
            sectionActiveCache,
            grOverrideMap.get(studentId),
            changedBy,
          );
          results.push(outcome);
        }));
      }
    } else {
      for (let i = 0; i < candidates.length; i += CHUNK_SIZE) {
        const chunk = candidates.slice(i, i + CHUNK_SIZE);
        await Promise.all(chunk.map(async (student) => {
          const outcome = await this.processPromotionForStudent(
            student,
            fromClass,
            toClass,
            isGraduating,
            isExpelling,
            isLeaving,
            isExplicitIds,
            dto.to_section_id,
            dto.reason,
            dto.target_academic_year,
            dryRun,
            classActiveCache,
            sectionActiveCache,
            grOverrideMap.get(student.cc),
            changedBy,
          );
          results.push(outcome);
        }));
      }
    }

    const total_promoted = results.filter((r) => r.status === 'promoted').length;
    const total_graduated = results.filter((r) => r.status === 'graduated').length;
    const total_expelled = results.filter((r) => r.status === 'expelled').length;
    const total_left = results.filter((r) => r.status === 'left').length;
    const total_skipped = results.filter((r) => r.status === 'skipped').length;
    const total_failed = results.filter((r) => r.status === 'failed').length;

    return {
      summary: {
        total_requested: results.length,
        total_promoted: total_promoted + total_graduated + total_expelled + total_left,
        total_promoted_only: total_promoted,
        total_graduated,
        total_expelled,
        total_left,
        total_skipped,
        total_failed,
        dry_run: dryRun,
        mode: isGraduating ? 'graduation' : isExpelling ? 'expulsion' : isLeaving ? 'leaving' : 'promotion',
      },
      from_class: fromClass,
      to_class: toClass,
      results,
    };
  }

  private async processPromotionForStudent(
    student: {
      cc: number;
      full_name: string | null;
      class_id: number | null;
      section_id: number | null;
      campus_id: number | null;
      house_id: number | null;
      academic_year: string | null;
      status: string;
      gr_number: string | null;
      gender: string | null;
    },
    fromClass: ResolvedClass | null,
    toClass: ResolvedClass | null,
    isGraduating: boolean,
    isExpelling: boolean,
    isLeaving: boolean,
    isExplicitIds: boolean,
    toSectionId: number | undefined,
    reason: string | undefined,
    targetAcademicYear: string | undefined,
    dryRun: boolean,
    classActiveCache: Map<string, boolean>,
    sectionActiveCache: Map<string, boolean>,
    grOverride: string | undefined,
    changedBy: string,
  ): Promise<PromotionOutcome> {
    // ── Already expelled guard ───────────────────────────────────────────────
    if (student.status === StudentStatus.EXPELLED) {
      return {
        student_id: student.cc,
        status: 'skipped',
        reason_code: 'ALREADY_EXPELLED',
        message: isExpelling
          ? 'Student is already expelled'
          : 'Expelled student cannot be promoted',
        from_class_id: student.class_id,
        to_class_id: student.class_id,
        from_academic_year: student.academic_year,
        expelled: true,
        dry_run: dryRun,
      };
    }

    // ── Already left guard ───────────────────────────────────────────────────
    if (student.status === StudentStatus.LEFT) {
      return {
        student_id: student.cc,
        status: 'skipped',
        reason_code: 'ALREADY_LEFT',
        message: isLeaving
          ? 'Student has already left'
          : 'Student who has left cannot be promoted',
        from_class_id: student.class_id,
        to_class_id: student.class_id,
        from_academic_year: student.academic_year,
        left: true,
        dry_run: dryRun,
      };
    }

    // ── Already graduated guard ──────────────────────────────────────────────
    if (student.status === StudentStatus.GRADUATED) {
      return {
        student_id: student.cc,
        status: 'skipped',
        reason_code: 'ALREADY_GRADUATED',
        message: 'Student is already graduated',
        from_class_id: student.class_id,
        to_class_id: toClass?.id ?? null,
        from_academic_year: student.academic_year,
        graduated: true,
        dry_run: dryRun,
      };
    }

    // ── From-class mismatch ──────────────────────────────────────────────────
    // For expel/left/graduate, fromClass may be null (no class required) — skip check.
    // For bulk (no explicit IDs): strict failure — the student shouldn't be in this batch.
    // For explicit IDs: softer skip — the caller asked for this specific student
    // but they're not in the expected class. Log it but don't inflate failure count.
    if (fromClass && student.class_id !== fromClass.id) {
      return {
        student_id: student.cc,
        status: isExplicitIds ? 'skipped' : 'failed',
        reason_code: 'FROM_CLASS_MISMATCH',
        message: isExplicitIds
          ? `Student is in a different class (id=${student.class_id}) — skipped`
          : 'Student is not currently assigned to the selected from class',
        from_class_id: student.class_id,
        to_class_id: toClass?.id ?? null,
        from_academic_year: student.academic_year,
        dry_run: dryRun,
      };
    }

    // ── Compute target academic year ─────────────────────────────────────────
    // Priority: explicit request override > auto-increment from student's year
    const nextAcademicYear = targetAcademicYear?.trim()
      ? targetAcademicYear.trim()
      : this.incrementAcademicYear(student.academic_year);

    // ── Already at target guard ──────────────────────────────────────────────
    if (!isGraduating && toClass) {
      // Student is already in target class AND already has the target academic year
      if (student.class_id === toClass.id && student.academic_year === nextAcademicYear) {
        return {
          student_id: student.cc,
          status: 'skipped',
          reason_code: 'ALREADY_AT_TARGET',
          message: 'Student is already in the target class and academic year',
          from_class_id: student.class_id,
          to_class_id: toClass.id,
          from_academic_year: student.academic_year,
          to_academic_year: nextAcademicYear,
          dry_run: dryRun,
        };
      }
    }

    // ── Campus/class mapping validation (promotion only) ─────────────────────
    // Resolve the destination section: if none was supplied, keep the current
    // section only when it remains valid for the destination class; otherwise clear it.
    let resolvedSectionId: number | null | undefined = toSectionId;
    if (!isGraduating && toClass && toSectionId === undefined) {
      if (student.section_id != null && student.campus_id != null) {
        const sectionKey = `${student.campus_id}:${toClass.id}:${student.section_id}`;
        let sectionIsActive = sectionActiveCache.get(sectionKey);
        if (sectionIsActive === undefined) {
          const sectionMapping = await this.prisma.campus_sections.findFirst({
            where: {
              campus_id: student.campus_id,
              class_id: toClass.id,
              section_id: student.section_id,
              is_active: true,
            },
            select: { id: true },
          });
          sectionIsActive = !!sectionMapping;
          sectionActiveCache.set(sectionKey, sectionIsActive);
        }
        resolvedSectionId = sectionIsActive ? student.section_id : null;
      } else {
        resolvedSectionId = student.section_id;
      }
    }

    if (!isGraduating && toClass) {
      const mappingValidation = await this.validateTargetMapping(
        student.campus_id,
        toClass.id,
        resolvedSectionId === null ? undefined : resolvedSectionId ?? toSectionId,
        classActiveCache,
        sectionActiveCache,
      );

      if (!mappingValidation.valid) {
        return {
          student_id: student.cc,
          status: 'failed',
          reason_code: mappingValidation.reason_code,
          message: mappingValidation.message,
          from_class_id: student.class_id,
          to_class_id: toClass.id,
          from_academic_year: student.academic_year,
          to_academic_year: nextAcademicYear,
          dry_run: dryRun,
        };
      }

      const sectionForRules =
        resolvedSectionId !== undefined ? resolvedSectionId : toSectionId ?? student.section_id;
      if (
        student.campus_id != null &&
        sectionForRules != null &&
        this.allocation.shouldValidatePlacement({
          campusId: student.campus_id,
          classId: toClass.id,
          sectionId: sectionForRules,
        })
      ) {
        try {
          await this.allocation.assertPlacementAllowed(
            {
              campusId: student.campus_id,
              classId: toClass.id,
              sectionId: sectionForRules,
            },
            {
              studentCc: student.cc,
              gender: student.gender,
              countsTowardCapacity: student.status === StudentStatus.ENROLLED,
            },
          );
        } catch (err: any) {
          const code = err?.response?.code || err?.response?.message?.code;
          const message =
            err?.response?.message?.message ||
            err?.response?.message ||
            err?.message ||
            'Section allocation rules rejected this promotion';
          const reason_code: PromotionReasonCode =
            code === ALLOCATION_ERROR_CODES.SECTION_FULL
              ? 'SECTION_FULL'
              : code === ALLOCATION_ERROR_CODES.SECTION_GENDER_RESTRICTED
                ? 'SECTION_GENDER_RESTRICTED'
                : code === ALLOCATION_ERROR_CODES.STUDENT_GENDER_REQUIRED
                  ? 'STUDENT_GENDER_REQUIRED'
                  : code === ALLOCATION_ERROR_CODES.SECTION_INACTIVE
                    ? 'SECTION_INACTIVE'
                    : code === ALLOCATION_ERROR_CODES.SECTION_NOT_OFFERED
                      ? 'SECTION_NOT_OFFERED'
                      : 'TARGET_SECTION_INVALID_FOR_CLASS_CAMPUS';
          return {
            student_id: student.cc,
            status: 'failed',
            reason_code,
            message: typeof message === 'string' ? message : 'Section allocation rules rejected this promotion',
            from_class_id: student.class_id,
            to_class_id: toClass.id,
            from_academic_year: student.academic_year,
            to_academic_year: nextAcademicYear,
            dry_run: dryRun,
          };
        }
      }
    }

    // ── Dry-run early return ─────────────────────────────────────────────────
    if (dryRun) {
      return {
        student_id: student.cc,
        status: isGraduating ? 'graduated' : isExpelling ? 'expelled' : isLeaving ? 'left' : 'promoted',
        message: isGraduating
          ? 'Student validated for graduation (dry-run)'
          : isExpelling
          ? 'Student validated for expulsion (dry-run)'
          : isLeaving
          ? 'Student validated for leaving (dry-run)'
          : 'Student validated successfully for promotion (dry-run)',
        from_class_id: student.class_id,
        to_class_id: isGraduating ? null : toClass?.id ?? student.class_id,
        from_academic_year: student.academic_year,
        to_academic_year: (isExpelling || isLeaving) ? undefined : nextAcademicYear,
        graduated: isGraduating,
        expelled: isExpelling,
        left: isLeaving,
        dry_run: true,
      };
    }

    // ── Commit to DB ─────────────────────────────────────────────────────────
    try {
      if (isGraduating) {
        // Graduation: set status to GRADUATED, null out class_id, all other data preserved
        await this.prisma.$transaction(async (tx) => {
          await tx.students.update({
            where: { cc: student.cc },
            data: {
              status: StudentStatus.GRADUATED,
              graduated_from_class_id: student.class_id,
              class_id: null,
              academic_year: nextAcademicYear,
            },
          });

          await tx.student_flags.create({
            data: {
              student_id: student.cc,
              flag: `GRADUATED_LOG_${Date.now()}`,
              reminder_date: new Date(),
              work_done: true,
              comment: reason?.trim() || null,
            },
          });

          await this.progressionHistory.recordProgressionChange(tx, {
            studentCc: student.cc,
            campusId: student.campus_id,
            classId: null,
            sectionId: student.section_id,
            houseId: student.house_id,
            academicYear: nextAcademicYear,
            grNumber: student.gr_number,
            changeType: 'GRADUATED',
            changedBy,
            notes: reason?.trim() || null,
          });
        });

        void this.auditLogs.log({
          entity_type: 'STUDENT',
          entity_id: String(student.cc),
          action: 'GRADUATED',
          field: 'status',
          old_value: student.status,
          new_value: StudentStatus.GRADUATED,
          changed_by: changedBy,
          student_id: student.cc,
          note: [`${student.full_name ?? `Student CC ${student.cc}`} graduated from class #${student.class_id ?? 'N/A'}.`, reason?.trim()]
            .filter(Boolean)
            .join(' '),
        });

        return {
          student_id: student.cc,
          status: 'graduated',
          message: 'Student graduated successfully',
          from_class_id: student.class_id,
          to_class_id: null,
          from_academic_year: student.academic_year,
          to_academic_year: nextAcademicYear,
          graduated: true,
          dry_run: false,
        };
      } else if (isExpelling) {
        // Expulsion: set status to EXPELLED and create a timestamped historical log entry.
        const expulsionReason = reason?.trim() || null;

        await this.prisma.$transaction(async (tx) => {
          await tx.students.update({
            where: { cc: student.cc },
            data: { status: StudentStatus.EXPELLED },
          });

          // Use timestamped flag (same pattern as changeStatus) so every expulsion
          // is individually logged and work_done: true (no persistent unresolved alert).
          await tx.student_flags.create({
            data: {
              student_id: student.cc,
              flag: `EXPELLED_LOG_${Date.now()}`,
              reminder_date: new Date(),
              comment: expulsionReason,
              work_done: true,
            },
          });
        });

        void this.auditLogs.log({
          entity_type: 'STUDENT',
          entity_id: String(student.cc),
          action: 'EXPELLED',
          field: 'status',
          old_value: student.status,
          new_value: StudentStatus.EXPELLED,
          changed_by: changedBy,
          student_id: student.cc,
          note: [`${student.full_name ?? `Student CC ${student.cc}`} expelled.`, expulsionReason].filter(Boolean).join(' '),
        });

        return {
          student_id: student.cc,
          status: 'expelled',
          message: 'Student expelled successfully',
          from_class_id: student.class_id,
          to_class_id: student.class_id, // unchanged
          from_academic_year: student.academic_year,
          expelled: true,
          dry_run: false,
        };
      } else if (isLeaving) {
        // Leaving: set status to LEFT and store left metadata.
        const leftDate = new Date();
        const leftReason = reason?.trim() || null;

        await this.prisma.$transaction(async (tx) => {
          await tx.students.update({
            where: { cc: student.cc },
            data: { status: StudentStatus.LEFT },
          });

          // Use a timestamped flag key so each left action creates a fresh log entry
          // (same pattern as GRADUATED_LOG_ and UNDO_LEFT_LOG_)
          await tx.student_flags.create({
            data: {
              student_id: student.cc,
              flag: `LEFT_LOG_${Date.now()}`,
              reminder_date: leftDate,
              comment: leftReason,
              work_done: true,
            },
          });
        });

        return {
          student_id: student.cc,
          status: 'left',
          message: 'Student marked as left successfully',
          from_class_id: student.class_id,
          to_class_id: student.class_id, // unchanged
          from_academic_year: student.academic_year,
          left: true,
          dry_run: false,
        };
      } else {
        // Normal promotion — A-Level promotions get next available A- GR from promoteBulk pre-allocation
        const resolvedGrOverride = grOverride;
        const effectiveGr = resolvedGrOverride ?? student.gr_number;

        if (resolvedGrOverride) {
          const duplicate = await this.prisma.students.findFirst({
            where: {
              campus_id: student.campus_id,
              gr_number: resolvedGrOverride,
              cc: { not: student.cc },
              deleted_at: null,
            },
          });
          if (duplicate) {
            return {
              student_id: student.cc,
              status: 'failed',
              reason_code: 'GR_DUPLICATE',
              message: `GR number ${resolvedGrOverride} is already in use`,
              from_class_id: student.class_id,
              to_class_id: toClass!.id,
              from_academic_year: student.academic_year,
              to_academic_year: nextAcademicYear,
              dry_run: false,
            };
          }
        }

        await this.prisma.$transaction(
          async (tx) => {
            const finalSectionId =
              resolvedSectionId !== undefined
                ? resolvedSectionId
                : toSectionId !== undefined
                  ? toSectionId
                  : student.section_id;

            await tx.students.update({
              where: { cc: student.cc },
              data: {
                class_id: toClass!.id,
                section_id: finalSectionId,
                academic_year: nextAcademicYear,
                ...(resolvedGrOverride ? { gr_number: resolvedGrOverride } : {}),
              },
            });

            await tx.student_admissions.create({
              data: {
                student_id: student.cc,
                academic_system: toClass!.academic_system,
                requested_grade: toClass!.description,
                academic_year: nextAcademicYear,
              },
            });

            await this.progressionHistory.recordProgressionChange(tx, {
              studentCc: student.cc,
              campusId: student.campus_id,
              classId: toClass!.id,
              sectionId: finalSectionId ?? null,
              houseId: student.house_id,
              academicYear: nextAcademicYear,
              grNumber: effectiveGr,
              changeType: 'PROMOTED',
              changedBy,
            });
          },
          { maxWait: 5000, timeout: 15000 },
        );

        void this.auditLogs.log({
          entity_type: 'STUDENT',
          entity_id: String(student.cc),
          action: 'PROMOTED',
          field: 'class_id',
          old_value: student.class_id != null ? String(student.class_id) : null,
          new_value: String(toClass!.id),
          changed_by: changedBy,
          student_id: student.cc,
          note: [
            `${student.full_name ?? `Student CC ${student.cc}`} promoted from ${student.academic_year ?? 'N/A'} to ${nextAcademicYear}.`,
            reason?.trim(),
          ]
            .filter(Boolean)
            .join(' '),
        });

        return {
          student_id: student.cc,
          status: 'promoted',
          message: 'Student promoted successfully',
          from_class_id: student.class_id,
          to_class_id: toClass!.id,
          from_academic_year: student.academic_year,
          to_academic_year: nextAcademicYear,
          dry_run: false,
        };
      }
    } catch {
      return {
        student_id: student.cc,
        status: 'failed',
        reason_code: 'INTERNAL_ERROR',
        message: 'Unexpected error occurred during promotion/graduation/expulsion',
        from_class_id: student.class_id,
        to_class_id: toClass?.id ?? null,
        from_academic_year: student.academic_year,
        to_academic_year: nextAcademicYear,
        dry_run: false,
      };
    }
  }

  private isALevelAcademicSystem(system?: string | null): boolean {
    return system?.toLowerCase().replace(/[^a-z]/g, '') === 'alevel';
  }

  private async resolveClassSelector(
    selector: ClassSelectorDto,
    fieldName: 'from' | 'to',
  ): Promise<ResolvedClass> {
    if (!selector || (selector.class_id === undefined && !selector.class_label?.trim())) {
      throw new BadRequestException(`${fieldName} selector requires class_id or class_label`);
    }

    if (selector.class_id !== undefined) {
      const cls = await this.prisma.classes.findUnique({
        where: { id: selector.class_id },
        select: {
          id: true,
          description: true,
          class_code: true,
          academic_system: true,
        },
      });

      if (!cls) {
        throw new BadRequestException(`${fieldName} class not found for class_id=${selector.class_id}`);
      }

      return cls;
    }

    const label = selector.class_label!.trim();
    const cls = await this.prisma.classes.findFirst({
      where: {
        OR: [
          { description: { equals: label, mode: 'insensitive' } },
          { class_code: { equals: label, mode: 'insensitive' } },
        ],
      },
      select: {
        id: true,
        description: true,
        class_code: true,
        academic_system: true,
      },
    });

    if (!cls) {
      throw new BadRequestException(`${fieldName} class not found for class_label=${label}`);
    }

    return cls;
  }

  private async validateTargetMapping(
    campusId: number | null,
    toClassId: number,
    toSectionId: number | undefined,
    classActiveCache: Map<string, boolean>,
    sectionActiveCache: Map<string, boolean>,
  ): Promise<{ valid: true } | { valid: false; reason_code: PromotionReasonCode; message: string }> {
    if (!campusId) {
      return { valid: true };
    }

    const classKey = `${campusId}:${toClassId}`;
    let classIsActive = classActiveCache.get(classKey);
    if (classIsActive === undefined) {
      const mapping = await this.prisma.campus_classes.findFirst({
        where: {
          campus_id: campusId,
          class_id: toClassId,
          is_active: true,
        },
        select: { id: true },
      });
      classIsActive = !!mapping;
      classActiveCache.set(classKey, classIsActive);
    }

    if (!classIsActive) {
      return {
        valid: false,
        reason_code: 'TARGET_CLASS_INACTIVE_FOR_CAMPUS',
        message: 'Target class is not active for the student campus',
      };
    }

    if (toSectionId === undefined) {
      return { valid: true };
    }

    const sectionKey = `${campusId}:${toClassId}:${toSectionId}`;
    let sectionIsActive = sectionActiveCache.get(sectionKey);
    if (sectionIsActive === undefined) {
      const sectionMapping = await this.prisma.campus_sections.findFirst({
        where: {
          campus_id: campusId,
          class_id: toClassId,
          section_id: toSectionId,
          is_active: true,
        },
        select: { id: true },
      });
      sectionIsActive = !!sectionMapping;
      sectionActiveCache.set(sectionKey, sectionIsActive);
    }

    if (!sectionIsActive) {
      return {
        valid: false,
        reason_code: 'TARGET_SECTION_INVALID_FOR_CLASS_CAMPUS',
        message: 'Target section is not valid for the target class and campus',
      };
    }

    return { valid: true };
  }

  private incrementAcademicYear(currentAcademicYear: string | null): string {
    // YYYY-YYYY range format (e.g. "2024-2025" → "2025-2026")
    const yearRangeMatch = currentAcademicYear?.match(/^(\d{4})-(\d{4})$/);
    if (yearRangeMatch) {
      const start = Number(yearRangeMatch[1]);
      const end = Number(yearRangeMatch[2]);
      return `${start + 1}-${end + 1}`;
    }

    // Single YYYY format (e.g. "2024" → "2025-2026")
    const yearOnlyMatch = currentAcademicYear?.match(/^(\d{4})$/);
    if (yearOnlyMatch) {
      const year = Number(yearOnlyMatch[1]);
      return `${year + 1}-${year + 2}`;
    }

    // Fallback: use next calendar year as start
    const fallbackStartYear = new Date().getFullYear() + 1;
    return `${fallbackStartYear}-${fallbackStartYear + 1}`;
  }

  async searchSimple(query: string) {
    const isNumeric = /^\d+$/.test(query);
    const results: any[] = [];

    // 1. Check for exact CC match if query is numeric
    if (isNumeric) {
      const exactMatch = await this.prisma.students.findFirst({
        where: { cc: Number(query), deleted_at: null },
        select: {
          cc: true,
          full_name: true,
          gr_number: true,
        },
      });
      if (exactMatch) results.push(exactMatch);
    }

    // 2. Fetch partial matches for names and GR numbers
    const where: Prisma.studentsWhereInput = {
      deleted_at: null,
      OR: [
        { full_name: { contains: query, mode: 'insensitive' } },
        { gr_number: { contains: query, mode: 'insensitive' } },
      ],
    };

    // Exclude exact match if already added
    if (results.length > 0) {
      where.NOT = { cc: results[0].cc };
    }

    const others = await this.prisma.students.findMany({
      where,
      take: 5 - results.length,
      select: {
        cc: true,
        full_name: true,
        gr_number: true,
      },
      orderBy: { full_name: 'asc' },
    });

    return [...results, ...others];
  }

  async getPaymentHistory(studentId: number, academicYear: string) {
    const student = await this.prisma.students.findUnique({
      where: { cc: studentId },
      include: {
        campuses: { select: { campus_name: true, campus_code: true } },
        classes: { select: { description: true, class_code: true } },
        sections: { select: { description: true } },
      },
    });

    if (!student) throw new NotFoundException(`Student #${studentId} not found`);

    // Fetch data for the specified academic year
    const [fees, vouchers, allDeposits] = await Promise.all([
      this.prisma.student_fees.findMany({
        where: { student_id: studentId, academic_year: academicYear },
        include: {
          fee_types: true,
          student_fee_bundles: true,
          student_fee_installments: true,
          deposit_allocations: {
            include: { deposits: true },
          },
          voucher_heads: {
            include: { vouchers: true },
          },
        },
        orderBy: { fee_date: 'asc' },
      }),
      this.prisma.vouchers.findMany({
        where: { student_id: studentId, academic_year: academicYear },
        include: {
          voucher_heads: {
            include: {
              student_fees: {
                include: { fee_types: true },
              },
            },
          },
          deposit_allocations: {
            include: { deposits: true },
          },
          bank_accounts: true,
          voucher_arrear_surcharges: true,
        },
        orderBy: { fee_date: 'desc' },
      }),
      this.prisma.deposits.findMany({
        where: { student_id: studentId },
        include: {
          deposit_allocations: {
            include: {
              student_fees: {
                include: { fee_types: true },
              },
              vouchers: true,
            },
          },
        },
        orderBy: { deposit_date: 'desc' },
      }),
    ]);

    (vouchers as any[]).forEach((v) => {
      const surchargeRows = v.voucher_arrear_surcharges || [];
      const totalAmt = surchargeRows.reduce((sum: number, s: any) => sum + Number(s.amount), 0);
      v.total_arrear_surcharge = new Prisma.Decimal(totalAmt);
    });

    // Arrears History - Cumulative across all time
    // Identifiable as heads where student_fees.academic_year != vouchers.academic_year
    const arrearsResult: any = await this.prisma.$queryRaw`
      SELECT SUM(vh.net_amount) as total
      FROM public.voucher_heads vh
      JOIN public.vouchers v ON vh.voucher_id = v.id
      JOIN public.student_fees sf ON vh.student_fee_id = sf.id
      WHERE v.student_id = ${studentId}
      AND sf.academic_year != v.academic_year
    `;
    const totalArrearsEver = Number(arrearsResult[0]?.total || 0);

    // Stats calculation logic
    let totalDue = new Prisma.Decimal(0);
    let totalPaid = new Prisma.Decimal(0);
    let paidOnTime = new Prisma.Decimal(0);
    let paidLate = new Prisma.Decimal(0);
    let stillOutstanding = new Prisma.Decimal(0);
    const paymentDays: number[] = [];

    fees.forEach((f) => {
      // Rule: total dues should only calculate the fees of challans with status NOT void
      // This ensures we exclude "NOT_ISSUED" fees and "VOID" vouchers from the collection rate denominator.
      const hasValidVoucher = f.voucher_heads.some((vh) => vh.vouchers.status !== 'VOID');

      if (hasValidVoucher) {
        const amount = new Prisma.Decimal(f.amount || 0);
        const amountPaid = new Prisma.Decimal(f.amount_paid || 0);
        totalDue = totalDue.add(amount);
        totalPaid = totalPaid.add(amountPaid);

        // For heads with no deposit at all and fee_date < today: outstanding += student_fees.amount - amount_paid
        if (amountPaid.lt(amount) && f.fee_date && f.fee_date < new Date()) {
          stillOutstanding = stillOutstanding.add(amount.sub(amountPaid));
        }
      }
    });

    // On-time vs Late logic from all deposits allocations
    allDeposits.forEach((d) => {
      d.deposit_allocations.forEach((a) => {
        if (a.voucher_id && a.vouchers) {
          const depDate = new Date(d.deposit_date);
          const dueDate = new Date(a.vouchers.due_date);
          if (depDate <= dueDate) {
            paidOnTime = paidOnTime.add(a.amount);
          } else {
            paidLate = paidLate.add(a.amount);
          }
        }

        // Velocity Stats: Average days between a fee's fee_date and the date it was actually paid
        if (a.student_fees?.fee_date) {
          const diffTime = Math.abs(
            new Date(d.deposit_date).getTime() -
              new Date(a.student_fees.fee_date).getTime(),
          );
          const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
          paymentDays.push(diffDays);
        }
      });
    });

    // A superseded/split voucher is only marked VOID, never deleted, so its
    // surcharge rows are still sitting in the DB alongside the fresh rows the
    // replacement voucher got for the same arrear — summing across every
    // voucher here would double-count that surcharge. Excluded the same way
    // `hasValidVoucher` already excludes VOID vouchers from fee totals above.
    const nonVoidVouchers = (vouchers as any[]).filter((v) => v.status !== 'VOID');
    const totalSurchargesCharged = nonVoidVouchers.reduce(
      (sum, v) => sum.add(v.total_arrear_surcharge || 0),
      new Prisma.Decimal(0),
    );
    const totalSurchargesWaived = nonVoidVouchers.reduce(
      (sum, v) =>
        v.surcharge_waived
          ? sum.add(v.total_arrear_surcharge || 0)
          : sum,
      new Prisma.Decimal(0),
    );

    // Format Vouchers Tab
    const formattedVouchers = (vouchers as any[]).map((v) => ({
      ...v,
      total_payable_before_due: Number(v.total_payable_before_due),
      total_payable_after_due: Number(v.total_payable_after_due),
      total_arrears: Number(v.total_arrears),
      total_arrear_surcharge: Number(v.total_arrear_surcharge),
      heads: v.voucher_heads.map((vh) => ({
        ...vh,
        net_amount: Number(vh.net_amount),
        amount_deposited: Number(vh.amount_deposited),
        balance: Number(vh.balance),
        description: `${vh.description_prefix || vh.student_fees?.description_prefix || ''} ${vh.student_fees?.fee_types?.description || 'N/A'}`.trim(),
        is_arrear: vh.student_fees?.fee_date && v.fee_date ? vh.student_fees.fee_date < v.fee_date : false,
        is_arrear_surcharge: vh.student_fees?.is_arrear_surcharge,
        source_fee_id: vh.student_fee_id,
      })),
      deposit_allocations: v.deposit_allocations.map((a) => ({
        ...a,
        amount: Number(a.amount),
        deposit_date: a.deposits.deposit_date,
        payment_method: a.deposits.payment_method,
        reference_number: a.deposits.reference_number,
        remarks: a.deposits.remarks,
      })),
      voucher_totals: {
        total_payable: Number(v.total_payable_before_due),
        total_deposited: v.deposit_allocations.reduce((s, a) => s + Number(a.amount), 0),
        outstanding_balance: Number(v.total_payable_before_due) - v.deposit_allocations.reduce((s, a) => s + Number(a.amount), 0)
      }
    }));

    // Format Fee Heads Tab
    const monthMap = new Map<number, any>();
    fees.forEach((f) => {
      if (!monthMap.has(f.target_month)) {
        monthMap.set(f.target_month, {
          target_month: f.target_month,
          academic_year: f.academic_year,
          heads: [],
          month_total_due: 0,
          month_total_paid: 0,
          month_balance: 0,
        });
      }
      const group = monthMap.get(f.target_month);
      const amount = Number(f.amount || 0);
      const amountPaid = Number(f.amount_paid || 0);
      group.month_total_due += amount;
      group.month_total_paid += amountPaid;
      group.month_balance = group.month_total_due - group.month_total_paid;

      group.heads.push({
        ...f,
        amount: Number(f.amount),
        amount_paid: Number(f.amount_paid),
        amount_before_discount: Number(f.amount_before_discount),
        fee_type_description: `${f.description_prefix || ''} ${f.fee_types?.description ?? 'Discount'}`.trim(),
        // 'PARTIAL PAYMENT OF...' rows are the paid half of a voucher split; their
        // 'BALANCE PAYMENT OF...' sibling keeps the original id and already occupies
        // that slot, so split fragments get neither their own label nor a count slot
        // (otherwise siblings would show e.g. "Installment 5 of 4").
        installment_label: f.installment_id && f.student_fee_installments && !((f.description_prefix || '').startsWith('PARTIAL PAYMENT OF'))
            ? `Installment ${fees.filter(sf =>
                sf.installment_id === f.installment_id &&
                sf.id <= f.id &&
                !((sf.description_prefix || '').startsWith('PARTIAL PAYMENT OF'))
              ).length} of ${f.student_fee_installments.installment_count}`
            : null,
        bundle_name: f.student_fee_bundles?.bundle_name,
        deposit_trail: f.deposit_allocations.map((a) => ({
          deposit_date: a.deposits.deposit_date,
          amount: Number(a.amount),
          payment_method: a.deposits.payment_method,
          reference_number: a.deposits.reference_number,
          voucher_id: a.voucher_id,
        })),
      });
    });

    // Format Deposits Tab
    // allDeposits is ordered deposit_date desc, so index 0 is this student's
    // most recent deposit — the only one currently allowed to be reversed
    // (deposits must be reversed most-recent-first, see assertDepositIsLatest).
    const formattedDeposits = allDeposits.map((d, idx) => ({
      ...d,
      is_latest: idx === 0,
      total_amount: Number(d.total_amount),
      allocations: d.deposit_allocations.map((a) => {
        const sf = a.student_fees as any;
        let feeTypeDescription: string;
        if (sf) {
          const prefix = sf.description_prefix ? `${sf.description_prefix} ` : '';
          feeTypeDescription = `${prefix}${sf.fee_types?.description || 'Fee'}`;
        } else if ((a as any).type === 'LATE_FEE') {
          feeTypeDescription = 'Late Fee Surcharge';
        } else if ((a as any).type === 'SURCHARGE') {
          feeTypeDescription = 'Arrear Surcharge';
        } else {
          feeTypeDescription = 'Fee Allocation';
        }
        return {
          amount: Number(a.amount),
          type: (a as any).type ?? 'FEE_HEAD',
          fee_type_description: feeTypeDescription,
          fee_date: sf?.fee_date ?? null,
          target_month: sf?.target_month ?? null,
          academic_year: sf?.academic_year ?? (a as any).vouchers?.academic_year ?? null,
          voucher_id: a.voucher_id,
          student_fee_id: a.student_fee_id,
        };
      }),
    }));

    return {
      student,
      stats: {
        total_due: totalDue.toNumber(),
        total_paid: totalPaid.toNumber(),
        collection_rate: totalDue.gt(0) ? totalPaid.div(totalDue).mul(100).toNumber() : 0,
        paid_on_time: paidOnTime.toNumber(),
        paid_late: paidLate.toNumber(),
        still_outstanding: stillOutstanding.toNumber(),
        total_arrears_ever: totalArrearsEver,
        total_surcharges_charged: totalSurchargesCharged.toNumber(),
        total_surcharges_waived: totalSurchargesWaived.toNumber(),
        avg_days_to_pay: paymentDays.length > 0 ? Math.round(paymentDays.reduce((a, b) => a + b, 0) / paymentDays.length) : 0,
        fastest_payment_days: paymentDays.length > 0 ? Math.min(...paymentDays) : 0,
        slowest_payment_days: paymentDays.length > 0 ? Math.max(...paymentDays) : 0,
      },
      vouchers: formattedVouchers,
      fee_heads: Array.from(monthMap.values()).sort((a, b) => a.target_month - b.target_month),
      deposits: formattedDeposits,
      total_deposited_all_time: allDeposits.reduce((s, d) => s + Number(d.total_amount), 0),
      total_deposited_current_year: allDeposits
        .filter(d => d.deposit_allocations.some(a => a.student_fees?.academic_year === academicYear || a.vouchers?.academic_year === academicYear))
        .reduce((s, d) => s + Number(d.total_amount), 0)
    };
  }
}
