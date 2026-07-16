import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateUnconfirmedAdmissionDto } from './dto/create-unconfirmed-admission.dto';
import { renderToBuffer } from '@react-pdf/renderer';
import * as React from 'react';
import { DepositSlipPDF } from './DepositSlipPDF';
import { StorageService } from '../../common/storage/storage.service';
import { CcAllocatorService } from '../identity/cc-allocator.service';
import { StudentStatus } from '../../constants/student-status.constant';

type TxClient = Prisma.TransactionClient;

export type QuickAdmissionMeta = {
  address?: string;
  admin_notes?: string;
  created_by?: string;
  deposit_amount?: number;
};

@Injectable()
export class UnconfirmedAdmissionsService {
  private readonly logger = new Logger(UnconfirmedAdmissionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly ccAllocator: CcAllocatorService,
  ) {}

  private calculateAge(dob: Date): string {
    const today = new Date();
    let age = today.getFullYear() - dob.getFullYear();
    const monthDiff = today.getMonth() - dob.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
      age--;
    }
    return `${age} Yrs`;
  }

  private metaOf(student: { quick_admission_meta?: unknown }): QuickAdmissionMeta {
    return ((student.quick_admission_meta as QuickAdmissionMeta) || {}) as QuickAdmissionMeta;
  }

  private mapRelation(relation?: string): string {
    const rel = (relation || 'GUARDIAN').toUpperCase();
    if (rel === 'FATHER') return 'Father';
    if (rel === 'MOTHER') return 'Mother';
    return 'Guardian';
  }

  /** Legacy API shape expected by webapp/Flutter (`id` = CC). */
  private toLegacyResponse(student: any) {
    const meta = this.metaOf(student);
    const guardians = (student.student_guardians || []).map((sg: any) => ({
      name: sg.guardians?.full_name || '',
      relation: sg.relationship || 'Guardian',
      cnic: sg.guardians?.cnic || undefined,
      photograph_url: sg.guardians?.photo_url || undefined,
    }));

    const admission = (student.student_admissions || [])[0];

    return {
      id: student.cc,
      full_name: student.full_name,
      date_of_birth: student.dob,
      gender: student.gender,
      address: meta.address ?? null,
      campus_id: student.campus_id,
      photograph_url: student.photograph_url,
      deposit_amount: meta.deposit_amount ?? 0,
      created_at: student.created_at,
      created_by: meta.created_by ?? null,
      guardians,
      academic_system: admission?.academic_system ?? null,
      requested_grade: admission?.requested_grade ?? null,
      admin_notes: meta.admin_notes ?? null,
      campuses: student.campuses ?? null,
      status: student.status,
      source: 'quick_admission',
    };
  }

  private async findQuickStudent(cc: number, requireQuickStatus = true) {
    const student = await this.prisma.students.findFirst({
      where: {
        cc,
        deleted_at: null,
        ...(requireQuickStatus ? { status: StudentStatus.QUICK_ADMISSION } : {}),
      },
      include: {
        campuses: true,
        student_admissions: { orderBy: { application_date: 'desc' } },
        student_guardians: {
          orderBy: { guardian_id: 'asc' },
          include: { guardians: true },
        },
      },
    });
    // Deposit slip / getByCC after promote: still allow if meta exists
    if (!requireQuickStatus && student && !student.quick_admission_meta && student.status !== StudentStatus.QUICK_ADMISSION) {
      return null;
    }
    return student;
  }

  private async upsertQuickGuardian(
    tx: TxClient,
    studentCc: number,
    g: { name: string; relation: string; cnic?: string },
    opts: { address?: string; isPrimary?: boolean } = {},
  ) {
    const { address, isPrimary = false } = opts;
    const cnic = g.cnic && g.cnic !== 'N/A' ? g.cnic : null;
    const fullName = g.name?.trim() || null;
    const relationship = this.mapRelation(g.relation);

    const payload = {
      cnic,
      full_name: fullName,
      mailing_address: address ?? null,
      house_appt_name: address ?? null,
    };

    let guardian;
    if (cnic) {
      guardian = await tx.guardians.upsert({
        where: { cnic },
        create: payload,
        update: {
          full_name: fullName ?? undefined,
          mailing_address: address ?? undefined,
          house_appt_name: address ?? undefined,
        },
      });
    } else {
      guardian = await tx.guardians.create({ data: payload });
    }

    await tx.student_guardians.upsert({
      where: {
        student_id_guardian_id: {
          student_id: studentCc,
          guardian_id: guardian.id,
        },
      },
      create: {
        student_id: studentCc,
        guardian_id: guardian.id,
        relationship,
        is_primary_contact: isPrimary,
        is_emergency_contact: isPrimary,
      },
      update: {
        relationship,
        is_primary_contact: isPrimary,
      },
    });

    return guardian;
  }

  async create(dto: CreateUnconfirmedAdmissionDto, createdBy?: string) {
    const dateOfBirth = new Date(dto.date_of_birth);

    const student = await this.prisma.$transaction(async (tx) => {
      const nextCC = await this.ccAllocator.next(tx);

      const meta: QuickAdmissionMeta = {
        address: dto.address,
        admin_notes: dto.admin_notes,
        created_by: createdBy,
        deposit_amount: dto.deposit_amount,
      };

      const created = await tx.students.create({
        data: {
          cc: nextCC,
          full_name: dto.full_name,
          dob: dateOfBirth,
          gender: dto.gender,
          campus_id: dto.campus_id ?? undefined,
          status: StudentStatus.QUICK_ADMISSION,
          quick_admission_meta: meta as any,
        },
      });

      if (dto.academic_system || dto.requested_grade) {
        await tx.student_admissions.create({
          data: {
            student_id: created.cc,
            academic_system: String(dto.academic_system || 'Secondary'),
            requested_grade: String(dto.requested_grade || 'N/A'),
          },
        });
      }

      const guardians = dto.guardians || [];
      for (let i = 0; i < guardians.length; i++) {
        await this.upsertQuickGuardian(tx, created.cc, guardians[i], {
          address: dto.address,
          isPrimary: i === 0,
        });
      }

      return tx.students.findUniqueOrThrow({
        where: { cc: created.cc },
        include: {
          campuses: true,
          student_admissions: { orderBy: { application_date: 'desc' } },
          student_guardians: {
            orderBy: { guardian_id: 'asc' },
            include: { guardians: true },
          },
        },
      });
    });

    return this.toLegacyResponse(student);
  }

  async getByCC(cc: number) {
    const student = await this.findQuickStudent(cc);
    if (student) {
      return this.toLegacyResponse(student);
    }

    // Collision leftovers still readable for ops
    const admission = await this.prisma.unconfirmed_admissions.findUnique({
      where: { id: cc },
      include: { campuses: true },
    });
    if (!admission) {
      throw new NotFoundException(`Quick admission with CC ${cc} not found`);
    }
    return admission;
  }

  async uploadPhoto(cc: number, file: Express.Multer.File) {
    const student = await this.prisma.students.findFirst({
      where: { cc, status: StudentStatus.QUICK_ADMISSION, deleted_at: null },
    });
    if (!student) {
      throw new NotFoundException(`Quick admission with CC ${cc} not found`);
    }

    const extension = file.originalname.split('.').pop() || 'jpg';
    const key = `media/quick-admissions/${cc}/photo-${Date.now()}.${extension}`;
    const url = await this.storage.upload(key, file.buffer, file.mimetype);

    await this.prisma.students.update({
      where: { cc },
      data: { photograph_url: url },
    });

    return { url };
  }

  async uploadGuardianPhoto(cc: number, guardianIndex: number, file: Express.Multer.File) {
    const student = await this.findQuickStudent(cc);
    if (!student) {
      throw new NotFoundException(`Quick admission with CC ${cc} not found`);
    }

    const links = student.student_guardians || [];
    if (!links[guardianIndex]) {
      throw new NotFoundException(`Guardian at index ${guardianIndex} not found for CC ${cc}`);
    }

    const guardianId = links[guardianIndex].guardian_id;
    const extension = file.originalname.split('.').pop() || 'jpg';
    const key = `media/quick-admissions/${cc}/guardian-${guardianIndex}-photo-${Date.now()}.${extension}`;
    const url = await this.storage.upload(key, file.buffer, file.mimetype);

    await this.prisma.guardians.update({
      where: { id: guardianId },
      data: { photo_url: url },
    });

    return { url };
  }

  async generateDepositSlipPdf(cc: number): Promise<Buffer> {
    const student = await this.findQuickStudent(cc, false);
    if (!student) {
      // Fall back to leftover unconfirmed row for ops collisions
      const admission = await this.prisma.unconfirmed_admissions.findUnique({
        where: { id: cc },
        include: { campuses: true },
      });
      if (!admission) {
        throw new NotFoundException(`Quick admission with CC ${cc} not found`);
      }
      return this.renderSlipFromUnconfirmed(admission);
    }

    const meta = this.metaOf(student);
    const ageStr = student.dob ? this.calculateAge(student.dob) : '';
    const admission = (student.student_admissions || [])[0];
    const guardians = (student.student_guardians || []).map((sg: any) => ({
      name: sg.guardians?.full_name || '',
      relation: sg.relationship || 'Guardian',
      cnic: sg.guardians?.cnic || undefined,
    }));

    const props = {
      cc: student.cc,
      fullName: student.full_name,
      dateOfBirth: student.dob
        ? student.dob.toLocaleDateString('en-GB')
        : '',
      age: ageStr,
      gender: student.gender || '',
      address: meta.address || undefined,
      campusName: student.campuses?.campus_name || undefined,
      academicSystem: admission?.academic_system || undefined,
      requestedGrade: admission?.requested_grade || undefined,
      depositAmount: Number(meta.deposit_amount || 0).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
      guardians,
      adminNotes: meta.admin_notes || undefined,
      createdBy: meta.created_by || undefined,
      createdAt: student.created_at
        ? student.created_at.toLocaleDateString('en-GB')
        : '',
    };

    try {
      const reactElement = React.createElement(DepositSlipPDF, { data: props }) as any;
      const pdfBuffer = await renderToBuffer(reactElement);
      return Buffer.from(pdfBuffer);
    } catch (error) {
      this.logger.error(`Failed to generate PDF for quick admission CC ${cc}`, error);
      throw error;
    }
  }

  private async renderSlipFromUnconfirmed(admission: any): Promise<Buffer> {
    const ageStr = this.calculateAge(admission.date_of_birth);
    const props = {
      cc: admission.id,
      fullName: admission.full_name,
      dateOfBirth: admission.date_of_birth.toLocaleDateString('en-GB'),
      age: ageStr,
      gender: admission.gender,
      address: admission.address || undefined,
      campusName: admission.campuses?.campus_name || undefined,
      academicSystem: admission.academic_system || undefined,
      requestedGrade: admission.requested_grade || undefined,
      depositAmount: Number(admission.deposit_amount).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
      guardians: (admission.guardians as any[]) || [],
      adminNotes: admission.admin_notes || undefined,
      createdBy: admission.created_by || undefined,
      createdAt: admission.created_at.toLocaleDateString('en-GB'),
    };

    const reactElement = React.createElement(DepositSlipPDF, { data: props }) as any;
    const pdfBuffer = await renderToBuffer(reactElement);
    return Buffer.from(pdfBuffer);
  }
}
