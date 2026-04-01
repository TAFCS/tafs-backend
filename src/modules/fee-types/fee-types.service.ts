import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateFeeTypeDto } from './dto/create-fee-type.dto';
import { BulkUpdateFeeTypesDto } from './dto/bulk-update-fee-types.dto';

@Injectable()
export class FeeTypesService {
  constructor(private readonly prisma: PrismaService) {}

  private static readonly ACADEMIC_MONTHS = [
    'August',
    'September',
    'October',
    'November',
    'December',
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
  ];

  async findAll() {
    return this.prisma.fee_types.findMany({
      orderBy: { priority_order: 'asc' },
    });
  }

  async create(dto: CreateFeeTypeDto) {
    const normalizedBreakup = this.normalizeAndValidateBreakup(
      dto.breakup,
      'fee type',
      dto.freq,
    );

    return this.prisma.fee_types.create({
      data: {
        description: dto.description,
        freq: dto.freq,
        breakup: normalizedBreakup,
        priority_order: dto.priority_order,
      },
    });
  }

  async bulkUpdate(dto: BulkUpdateFeeTypesDto) {
    if (!dto.items || dto.items.length === 0) {
      return [];
    }

    for (const item of dto.items) {
      if (item.breakup !== undefined) {
        this.normalizeAndValidateBreakup(
          item.breakup,
          `fee type id=${item.id}`,
          item.freq,
        );
      }
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
              breakup: this.normalizeAndValidateBreakup(
                item.breakup,
                `fee type id=${item.id}`,
                item.freq,
              ),
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

  private normalizeAndValidateBreakup(
    breakup: Record<string, any> | undefined,
    context = 'fee type',
    freq?: string,
  ) {
    if (!breakup) {
      throw new BadRequestException(`Breakup is required for ${context}`);
    }

    let months: string[] = [];
    if (Array.isArray(breakup.months)) {
      months = breakup.months
        .map((m: unknown) => String(m).trim())
        .filter(Boolean);
    } else if (Array.isArray(breakup)) {
      months = breakup
        .map((m: unknown) => String(m).trim())
        .filter(Boolean);
    } else if (typeof breakup.months === 'string') {
      months = breakup.months
        .split(',')
        .map((m: string) => m.trim())
        .filter(Boolean);
    }

    if (months.length === 0) {
      throw new BadRequestException(`At least one month is required for ${context}`);
    }

    const invalidMonths = months.filter(
      (month) => !FeeTypesService.ACADEMIC_MONTHS.includes(month),
    );
    if (invalidMonths.length > 0) {
      throw new BadRequestException(
        `Invalid month values for ${context}: ${invalidMonths.join(', ')}`,
      );
    }

    const breakupObj = Array.isArray(breakup)
      ? ({} as Record<string, any>)
      : (breakup as Record<string, any>);
    const rawDayMap = breakupObj.collection_day_by_month ?? breakupObj.collection_date_by_month;
    if (!rawDayMap || typeof rawDayMap !== 'object' || Array.isArray(rawDayMap)) {
      throw new BadRequestException(
        `collection_day_by_month is required and must be an object for ${context}`,
      );
    }

    const normalizedDayMap: Record<string, number> = {};
    for (const month of months) {
      const value = rawDayMap[month];
      if (value === undefined || value === null || value === '') {
        throw new BadRequestException(
          `Missing collection day for month ${month} in ${context}`,
        );
      }

      let dayNumber: number | null = null;
      if (typeof value === 'number') {
        dayNumber = Number.isInteger(value) ? value : null;
      } else if (typeof value === 'string') {
        const trimmed = value.trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
          dayNumber = Number(trimmed.slice(8, 10));
        } else if (/^\d{1,2}$/.test(trimmed)) {
          dayNumber = Number(trimmed);
        }
      }

      if (!dayNumber || dayNumber < 1 || dayNumber > 31) {
        throw new BadRequestException(
          `Invalid collection day for month ${month} in ${context}; expected 1-31`,
        );
      }
      normalizedDayMap[month] = dayNumber;
    }

    if (freq === 'MONTHLY') {
      const uniqueDays = Array.from(new Set(Object.values(normalizedDayMap)));
      if (uniqueDays.length !== 1) {
        throw new BadRequestException(
          `Monthly fee types require one shared collection day across all selected months in ${context}`,
        );
      }
      const sharedDay = uniqueDays[0];
      for (const month of months) {
        normalizedDayMap[month] = sharedDay;
      }
    }

    return {
      months,
      collection_day_by_month: normalizedDayMap,
    };
  }
}

