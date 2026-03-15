import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateFeeTypeDto } from './dto/create-fee-type.dto';
import { BulkUpdateFeeTypesDto } from './dto/bulk-update-fee-types.dto';

@Injectable()
export class FeeTypesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    return this.prisma.fee_types.findMany({
      orderBy: { priority_order: 'asc' },
    });
  }

  async create(dto: CreateFeeTypeDto) {
    return this.prisma.fee_types.create({
      data: {
        description: dto.description,
        freq: dto.freq,
        breakup: dto.breakup ?? undefined,
        priority_order: dto.priority_order,
      },
    });
  }

  async bulkUpdate(dto: BulkUpdateFeeTypesDto) {
    if (!dto.items || dto.items.length === 0) {
      return [];
    }

    const updated = await this.prisma.$transaction(
      dto.items.map((item) =>
        this.prisma.fee_types.update({
          where: { id: item.id },
          data: {
            ...(item.description !== undefined && {
              description: item.description,
            }),
            ...(item.freq !== undefined && {
              freq: item.freq,
            }),
            ...(item.breakup !== undefined && {
              breakup: item.breakup,
            }),
            ...(item.priority_order !== undefined && {
              priority_order: item.priority_order,
            }),
          },
        }),
      ),
    );

    if (!updated || updated.length !== dto.items.length) {
      throw new NotFoundException('One or more fee types not found');
    }

    return updated;
  }

  async delete(id: number) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // 1. Delete associated student fees (no cascade in schema for this direction usually)
        await tx.student_fees.deleteMany({
          where: { fee_type_id: id },
        });

        // 2. Finally, delete the fee type record
        // Note: class_fee_schedule has onDelete: Cascade in schema, so it will be handled.
        return await tx.fee_types.delete({
          where: { id },
        });
      });
    } catch (e: any) {
      if (e?.code === 'P2025') {
        throw new NotFoundException(`Fee type #${id} not found`);
      }
      if (e?.code === 'P2003') {
        throw new Error('Cannot delete fee type as it is being referenced by other records.');
      }
      throw e;
    }
  }
}

