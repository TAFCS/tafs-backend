import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';

@Injectable()
export class SegmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    return this.prisma.segments.findMany({
      orderBy: { display_order: 'asc' },
      include: {
        _count: { select: { classes: true, employee_profiles: true } },
      },
    });
  }
}
