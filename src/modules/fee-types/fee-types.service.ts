import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateFeeTypeDto } from './dto/create-fee-type.dto';
import { BulkUpdateFeeTypesDto } from './dto/bulk-update-fee-types.dto';

@Injectable()
export class FeeTypesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    return this.prisma.fee_types.findMany({
      orderBy: { description: 'asc' },
    });
  }

  async create(dto: CreateFeeTypeDto) {
    return this.prisma.fee_types.create({
      data: {
        description: dto.description,
        freq: dto.freq,
        breakup: dto.breakup ?? undefined,
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
          },
        }),
      ),
    );

    if (!updated || updated.length !== dto.items.length) {
      throw new NotFoundException('One or more fee types not found');
    }

    return updated;
  }
}

