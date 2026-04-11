import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { GetStudentsDto } from './dto/get-students.dto';
import { calculateOffset } from '../../utils/pagination.util';
import { createPaginationMeta } from '../../utils/serializer.util';
import { Prisma } from '@prisma/client';
import { ClassSelectorDto } from './dto/class-selector.dto';
import { PromoteSingleStudentDto } from './dto/promote-single-student.dto';
import { PromoteBulkStudentsDto } from './dto/promote-bulk-students.dto';

type PromotionStatus = 'promoted' | 'skipped' | 'failed';

type PromotionReasonCode =
  | 'STUDENT_NOT_FOUND'
  | 'FROM_CLASS_MISMATCH'
  | 'ALREADY_AT_TARGET'
  | 'TARGET_CLASS_INACTIVE_FOR_CAMPUS'
  | 'TARGET_SECTION_INVALID_FOR_CLASS_CAMPUS'
  | 'INTERNAL_ERROR';

type PromotionOutcome = {
  student_id: number;
  status: PromotionStatus;
  reason_code?: PromotionReasonCode;
  message: string;
  from_class_id?: number | null;
  to_class_id?: number;
  from_academic_year?: string | null;
  to_academic_year?: string;
  dry_run: boolean;
};

type ResolvedClass = {
  id: number;
  description: string;
  class_code: string;
  academic_system: string;
};

@Injectable()
export class StudentsService {
  constructor(private readonly prisma: PrismaService) { }

  private readonly assignmentInclude = {
    campuses: { select: { campus_name: true, campus_code: true } },
    classes: { select: { description: true, class_code: true } },
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

  async findAll(query: GetStudentsDto) {
    const { page = 1, limit = 10, search, campus_id, class_id, section_id, house_id, status, fields } = query;
    const offset = calculateOffset(page, limit);

    const where: Prisma.studentsWhereInput = { deleted_at: null };

    if (search) {
      where.OR = [
        { full_name: { contains: search, mode: 'insensitive' } },
        { gr_number: { contains: search, mode: 'insensitive' } },
        ...(/^\d+$/.test(search) ? [{ cc: Number(search) }] : []),
        { student_guardians: { some: { guardians: { cnic: { contains: search, mode: 'insensitive' } } } } },
      ];
    }
    if (campus_id)   where.campus_id  = campus_id;
    if (class_id)    where.class_id   = class_id;
    if (section_id)  where.section_id = section_id;
    if (house_id)    where.house_id   = house_id;
    if (status)      where.status     = status;

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
      selectArgs.class_id  = true;
      selectArgs.section_id = true;
      selectArgs.house_id  = true;
      selectArgs.status = true;
      selectArgs.photograph_url = true;
      selectArgs.campuses  = { select: { campus_name: true, campus_code: true } };
      selectArgs.classes   = { select: { description: true, class_code: true } };
      selectArgs.sections  = { select: { description: true } };
      selectArgs.houses    = { select: { house_name: true, house_color: true } };
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
            select: {
              cc: true,
              full_name: true,
              student_guardians: {
                where: { is_primary_contact: true },
                take: 1,
                select: {
                  guardians: { select: { full_name: true } }
                }
              }
            }
          },
          _count: { select: { students: true } } // For sibling_count
        },
      };
    }

    if (requestedFields.has('contact')) {
      selectArgs.primary_phone = true;
      selectArgs.whatsapp_number = true;
      selectArgs.student_guardians = {
        where: { is_primary_contact: true },
        take: 1,
        select: {
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
      // Emergency info joins through guardians
      if (!selectArgs.student_guardians) {
        selectArgs.student_guardians = {};
      }
      selectArgs.student_guardians = {
        ...(typeof selectArgs.student_guardians === 'object' ? selectArgs.student_guardians : {}),
        where: { OR: [{ is_primary_contact: true }, { is_emergency_contact: true }] },
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

    // Execute count and data queries concurrently
    const [total, studentsData] = await Promise.all([
      this.prisma.students.count({ where }),
      this.prisma.students.findMany({
        where,
        skip: offset,
        take: limit,
        orderBy: { created_at: 'desc' },
        select: Object.keys(selectArgs).length > 1 ? selectArgs : { cc: true }, // Ensure at least cc is selected
      }),
    ]);

    // Map and flatten response structure
    const mappedItems = studentsData.map((s: any) => {
      let primaryGuardianNode: any = null;
      let emergencyGuardianNode: any = null;

      if (s.student_guardians) {
        primaryGuardianNode = s.student_guardians.find((g: any) => g.is_primary_contact !== false);
        emergencyGuardianNode = s.student_guardians.find((g: any) => g.is_emergency_contact === true);
        // fallback for when only one record exists but explicit booleans aren't returned safely
        if (!primaryGuardianNode && s.student_guardians.length > 0) primaryGuardianNode = s.student_guardians[0];
      }

      const primaryGuardian = primaryGuardianNode?.guardians;
      const emergencyGuardian = emergencyGuardianNode?.guardians;
      const latestAdmission = s.student_admissions?.[0] || null;
      const previousSchool = s.student_previous_schools?.[0] || null;

      const mappedData: any = { cc: s.cc };

      if (requestedFields.has('core')) {
        mappedData.core = {
          cc: s.cc,
          full_name: s.full_name,
          cc_number: s.cc,
          gr_number: s.gr_number,
          campus_name: s.campuses?.campus_name,
          campus_code: s.campuses?.campus_code,
          class_description: s.classes?.description,
          class_code: s.classes?.class_code,
          section_description: s.sections?.description,
          house_name: s.houses?.house_name,
          house_color: s.houses?.house_color,
          enrollment_status: s.status,
          photograph_url: s.photograph_url,
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
            ?.map((sib: any) => ({
              cc: sib.cc,
              full_name: sib.full_name,
              cc_number: sib.cc,
              father_name: sib.student_guardians?.[0]?.guardians?.full_name,
            })),
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

      // Add a flattened "legacy" root map for the frontend's existing datatable usage
      // This bridges the gap between the new nested structure and what the frontend expects.
      return {
        ...mappedData,
        // Frontend compatibility flattened fields:
        student_full_name: mappedData.core?.full_name,
        gr_number: mappedData.core?.gr_number,
        cc_number: mappedData.core?.cc_number,
        campus: mappedData.core?.campus_name,
        class_id: s.class_id,
        grade_and_section: mappedData.academic?.requested_grade,
        primary_guardian_name: mappedData.contact?.primary_guardian_name,
        whatsapp_number: mappedData.contact?.whatsapp_number,
        enrollment_status: mappedData.core?.enrollment_status,
        financial_status_badge: 'CLEARED', // Basic list view stays simple or we can add a check later
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

    return { items: mappedItems, meta };
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
        student_admissions: { orderBy: { application_date: 'desc' }, take: 1 },
        student_guardians: {
          include: { guardians: true }
        },
        student_previous_schools: { orderBy: { id: 'desc' }, take: 1 },
        student_activities: true,
      }
    });

    if (!s) throw new NotFoundException(`Student #${id} not found`);

    const primaryGuardianNode = s.student_guardians.find((g: any) => g.is_primary_contact === true) || s.student_guardians[0];
    const primaryGuardian = primaryGuardianNode?.guardians;
    const fatherNode = s.student_guardians.find((g: any) => g.relationship === 'FATHER') || primaryGuardianNode;

    const financial = await this.getFinancialDigest(s.cc);

    let resolvedClassId = s.class_id;
    if (!resolvedClassId && s.status === 'SOFT_ADMISSION') {
      const requestedGrade = s.student_admissions?.[0]?.requested_grade;
      if (requestedGrade) {
        const matchedClass = await this.prisma.classes.findFirst({
          where: { class_code: requestedGrade },
          select: { id: true }
        });
        resolvedClassId = matchedClass?.id ?? null;
      }
    }

    return {
      cc: s.cc,
      student_full_name: s.full_name,
      gr_number: s.gr_number,
      cc_number: s.cc,
      campus: s.campuses?.campus_name,
      campus_code: s.campuses?.campus_code,
      campus_id: s.campus_id,
      class_id: resolvedClassId,
      section_id: s.section_id,
      grade_and_section: s.student_admissions?.[0]?.requested_grade,
      enrollment_status: s.status,
      financial_status_badge: financial.badge,
      total_outstanding_balance: financial.outstanding,
      advance_credit_balance: financial.advance,
      family_id: s.family_id,
      household_name: s.families?.household_name,
      primary_guardian_name: primaryGuardian?.full_name,
      primary_guardian_cnic: primaryGuardian?.cnic,
      whatsapp_number: primaryGuardian?.whatsapp_number || s.whatsapp_number,
      primary_phone: primaryGuardian?.primary_phone || s.primary_phone,
      date_of_birth: s.dob,
      gender: s.gender,
      registration_number: s.cc,
      father_name: fatherNode?.guardians?.full_name || primaryGuardian?.full_name,
      residential_address: s.families?.primary_address,
      siblings: s.families?.students
        ?.filter((sib: any) => sib.cc !== s.cc)
        ?.map((sib: any) => ({
          cc: sib.cc,
          full_name: sib.full_name,
          cc_number: sib.cc,
          father_name: sib.student_guardians?.[0]?.guardians?.full_name,
        })),
    };
  }

  async assignStudent(id: number, dto: any) {
    const student = await this.prisma.students.findUnique({
        where: { cc: id },
    });

    if (!student || student.deleted_at) {
        throw new NotFoundException(`Student #${id} not found`);
    }

    return this.prisma.students.update({
        where: { cc: id },
        data: {
            campus_id: dto.campus_id !== undefined ? dto.campus_id : undefined,
            class_id: dto.class_id !== undefined ? dto.class_id : undefined,
            section_id: dto.section_id !== undefined ? dto.section_id : undefined,
            house_id: dto.house_id !== undefined ? dto.house_id : undefined,
        },
        include: this.assignmentInclude,
    });
  }

  async promoteSingle(dto: PromoteSingleStudentDto) {
    const result = await this.promoteBulk({
      from: dto.from,
      to: dto.to,
      to_section_id: dto.to_section_id,
      student_ids: [dto.student_id],
      reason: dto.reason,
      dry_run: dto.dry_run,
    });

    return {
      ...result,
      outcome: result.results[0] || null,
    };
  }

  async promoteBulk(dto: PromoteBulkStudentsDto) {
    const fromClass = await this.resolveClassSelector(dto.from, 'from');
    const toClass = await this.resolveClassSelector(dto.to, 'to');

    if (fromClass.id === toClass.id) {
      throw new BadRequestException('From and to class must be different for promotion');
    }

    const dryRun = !!dto.dry_run;
    const distinctStudentIds = dto.student_ids?.length
      ? Array.from(new Set(dto.student_ids))
      : undefined;

    const where: Prisma.studentsWhereInput = {
      deleted_at: null,
    };

    if (dto.campus_id !== undefined) {
      where.campus_id = dto.campus_id;
    }

    if (dto.section_id !== undefined) {
      where.section_id = dto.section_id;
    }

    if (distinctStudentIds && distinctStudentIds.length > 0) {
      where.cc = { in: distinctStudentIds };
    } else {
      where.class_id = fromClass.id;
    }

    const candidates = await this.prisma.students.findMany({
      where,
      select: {
        cc: true,
        class_id: true,
        section_id: true,
        campus_id: true,
        academic_year: true,
      },
      orderBy: { cc: 'asc' },
    });

    const classActiveCache = new Map<string, boolean>();
    const sectionActiveCache = new Map<string, boolean>();
    const results: PromotionOutcome[] = [];

    if (distinctStudentIds && distinctStudentIds.length > 0) {
      const byId = new Map(candidates.map((s) => [s.cc, s]));
      for (const studentId of distinctStudentIds) {
        const student = byId.get(studentId);
        if (!student) {
          results.push({
            student_id: studentId,
            status: 'failed',
            reason_code: 'STUDENT_NOT_FOUND',
            message: 'Student not found or does not match provided filters',
            dry_run: dryRun,
          });
          continue;
        }

        const outcome = await this.processPromotionForStudent(
          student,
          fromClass,
          toClass,
          dto.to_section_id,
          dto.reason,
          dryRun,
          classActiveCache,
          sectionActiveCache,
        );
        results.push(outcome);
      }
    } else {
      for (const student of candidates) {
        const outcome = await this.processPromotionForStudent(
          student,
          fromClass,
          toClass,
          dto.to_section_id,
          dto.reason,
          dryRun,
          classActiveCache,
          sectionActiveCache,
        );
        results.push(outcome);
      }
    }

    const total_promoted = results.filter((r) => r.status === 'promoted').length;
    const total_skipped = results.filter((r) => r.status === 'skipped').length;
    const total_failed = results.filter((r) => r.status === 'failed').length;

    return {
      summary: {
        total_requested: results.length,
        total_promoted,
        total_skipped,
        total_failed,
        dry_run: dryRun,
      },
      from_class: fromClass,
      to_class: toClass,
      results,
    };
  }

  private async processPromotionForStudent(
    student: {
      cc: number;
      class_id: number | null;
      section_id: number | null;
      campus_id: number | null;
      academic_year: string | null;
    },
    fromClass: ResolvedClass,
    toClass: ResolvedClass,
    toSectionId: number | undefined,
    _reason: string | undefined,
    dryRun: boolean,
    classActiveCache: Map<string, boolean>,
    sectionActiveCache: Map<string, boolean>,
  ): Promise<PromotionOutcome> {
    if (student.class_id !== fromClass.id) {
      return {
        student_id: student.cc,
        status: 'failed',
        reason_code: 'FROM_CLASS_MISMATCH',
        message: 'Student is not currently assigned to the selected from class',
        from_class_id: student.class_id,
        to_class_id: toClass.id,
        from_academic_year: student.academic_year,
        dry_run: dryRun,
      };
    }

    const nextAcademicYear = this.incrementAcademicYear(student.academic_year);

    if (student.class_id === toClass.id && student.academic_year === nextAcademicYear) {
      return {
        student_id: student.cc,
        status: 'skipped',
        reason_code: 'ALREADY_AT_TARGET',
        message: 'Student already exists at the target class and academic year',
        from_class_id: student.class_id,
        to_class_id: toClass.id,
        from_academic_year: student.academic_year,
        to_academic_year: nextAcademicYear,
        dry_run: dryRun,
      };
    }

    const mappingValidation = await this.validateTargetMapping(
      student.campus_id,
      toClass.id,
      toSectionId,
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

    if (dryRun) {
      return {
        student_id: student.cc,
        status: 'promoted',
        message: 'Student validated successfully for promotion (dry-run)',
        from_class_id: student.class_id,
        to_class_id: toClass.id,
        from_academic_year: student.academic_year,
        to_academic_year: nextAcademicYear,
        dry_run: true,
      };
    }

    try {
      await this.prisma.$transaction(
        async (tx) => {
          await tx.students.update({
            where: { cc: student.cc },
            data: {
              class_id: toClass.id,
              section_id: toSectionId !== undefined ? toSectionId : student.section_id,
              academic_year: nextAcademicYear,
            },
          });

          await tx.student_admissions.create({
            data: {
              student_id: student.cc,
              academic_system: toClass.academic_system,
              requested_grade: toClass.description,
              academic_year: nextAcademicYear,
            },
          });
        },
        {
          maxWait: 5000,
          timeout: 15000,
        },
      );

      return {
        student_id: student.cc,
        status: 'promoted',
        message: 'Student promoted successfully',
        from_class_id: student.class_id,
        to_class_id: toClass.id,
        from_academic_year: student.academic_year,
        to_academic_year: nextAcademicYear,
        dry_run: false,
      };
    } catch {
      return {
        student_id: student.cc,
        status: 'failed',
        reason_code: 'INTERNAL_ERROR',
        message: 'Unexpected error occurred while promoting student',
        from_class_id: student.class_id,
        to_class_id: toClass.id,
        from_academic_year: student.academic_year,
        to_academic_year: nextAcademicYear,
        dry_run: false,
      };
    }
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
    const yearRangeMatch = currentAcademicYear?.match(/^(\d{4})-(\d{4})$/);
    if (yearRangeMatch) {
      const start = Number(yearRangeMatch[1]);
      const end = Number(yearRangeMatch[2]);
      return `${start + 1}-${end + 1}`;
    }

    const yearOnlyMatch = currentAcademicYear?.match(/^(\d{4})$/);
    if (yearOnlyMatch) {
      const year = Number(yearOnlyMatch[1]);
      return `${year + 1}-${year + 2}`;
    }

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
}
