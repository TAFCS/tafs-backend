import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateUnconfirmedAdmissionDto } from './dto/create-unconfirmed-admission.dto';
import { renderToBuffer } from '@react-pdf/renderer';
import * as React from 'react';
import { DepositSlipPDF } from './DepositSlipPDF';
import { StorageService } from '../../common/storage/storage.service';

@Injectable()
export class UnconfirmedAdmissionsService {
  private readonly logger = new Logger(UnconfirmedAdmissionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
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

  async create(dto: CreateUnconfirmedAdmissionDto, createdBy?: string) {
    const dateOfBirth = new Date(dto.date_of_birth);

    return this.prisma.$transaction(async (tx) => {
      const maxStudent = await tx.students.aggregate({
        _max: { cc: true },
      });
      const maxUnconfirmed = await tx.unconfirmed_admissions.aggregate({
        _max: { id: true },
      });

      const nextCC = Math.max(maxStudent._max.cc || 0, maxUnconfirmed._max.id || 0) + 1;

      return tx.unconfirmed_admissions.create({
        data: {
          id: nextCC,
          full_name: dto.full_name,
          date_of_birth: dateOfBirth,
          gender: dto.gender,
          address: dto.address,
          campus_id: dto.campus_id,
          deposit_amount: dto.deposit_amount,
          created_by: createdBy,
          guardians: (dto.guardians as any) ?? [],
        },
        include: {
          campuses: true,
        },
      });
    });
  }

  async getByCC(cc: number) {
    const admission = await this.prisma.unconfirmed_admissions.findUnique({
      where: { id: cc },
      include: {
        campuses: true,
      },
    });
    if (!admission) {
      throw new NotFoundException(`Unconfirmed admission with CC ${cc} not found`);
    }
    return admission;
  }

  async uploadPhoto(cc: number, file: Express.Multer.File) {
    const admission = await this.prisma.unconfirmed_admissions.findUnique({
      where: { id: cc },
    });
    if (!admission) {
      throw new NotFoundException(`Unconfirmed admission with CC ${cc} not found`);
    }

    const extension = file.originalname.split('.').pop() || 'jpg';
    const key = `media/unconfirmed-admissions/${cc}/photo-${Date.now()}.${extension}`;
    const url = await this.storage.upload(key, file.buffer, file.mimetype);

    await this.prisma.unconfirmed_admissions.update({
      where: { id: cc },
      data: { photograph_url: url },
    });

    return { url };
  }

  async generateDepositSlipPdf(cc: number): Promise<Buffer> {
    const admission = await this.getByCC(cc);
    const ageStr = this.calculateAge(admission.date_of_birth);

    const props = {
      cc: admission.id,
      fullName: admission.full_name,
      dateOfBirth: admission.date_of_birth.toLocaleDateString('en-GB'),
      age: ageStr,
      gender: admission.gender,
      address: admission.address || undefined,
      campusName: admission.campuses?.campus_name || undefined,
      depositAmount: Number(admission.deposit_amount).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
      guardians: (admission.guardians as any[]) || [],
      createdAt: admission.created_at.toLocaleDateString('en-GB'),
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
}
