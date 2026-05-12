import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateChangeRequestDto } from './dto/create-change-request.dto';
import { ProcessChangeRequestDto, ChangeRequestStatus } from './dto/process-change-request.dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class ParentChangeRequestsService {
  constructor(private prisma: PrismaService) {}

  async createRequest(dto: CreateChangeRequestDto) {
    // Check if guardian and family exist
    const guardian = await this.prisma.guardians.findUnique({ where: { id: dto.guardian_id } });
    if (!guardian) throw new NotFoundException('Guardian not found');

    const family = await this.prisma.families.findUnique({ where: { id: dto.family_id } });
    if (!family) throw new NotFoundException('Family not found');

    return this.prisma.parent_change_requests.create({
      data: {
        guardian_id: dto.guardian_id,
        family_id: dto.family_id,
        requested_data: dto.requested_data as any,
        status: 'PENDING',
      },
    });
  }

  async listRequests() {
    return this.prisma.parent_change_requests.findMany({
      include: {
        guardians: {
          select: {
            full_name: true,
            primary_phone: true,
            email_address: true,
            cnic: true,
            occupation: true,
            job_position: true,
            organization: true,
            education_level: true,
            mailing_address: true,
          },
        },
        families: {
          select: {
            household_name: true,
          },
        },
        processor: {
          select: {
            full_name: true,
          },
        },
      },
      orderBy: { created_at: 'desc' },
    });
  }

  async getRequestById(id: number) {
    const request = await this.prisma.parent_change_requests.findUnique({
      where: { id },
      include: {
        guardians: true,
        families: true,
      },
    });
    if (!request) throw new NotFoundException('Change request not found');
    return request;
  }

  async processRequest(id: number, dto: ProcessChangeRequestDto, adminId: string) {
    const request = await this.getRequestById(id);

    if (request.status !== 'PENDING') {
      throw new BadRequestException('Request has already been processed');
    }

    return this.prisma.$transaction(async (tx) => {
      const updatedRequest = await tx.parent_change_requests.update({
        where: { id },
        data: {
          status: dto.status,
          comment: dto.comment,
          processed_by: adminId,
          processed_at: new Date(),
        },
      });

      if (dto.status === ChangeRequestStatus.APPROVED) {
        // Apply changes to the guardian record
        await tx.guardians.update({
          where: { id: request.guardian_id },
          data: request.requested_data as Prisma.InputJsonValue,
        });
      }

      return updatedRequest;
    });
  }
}
