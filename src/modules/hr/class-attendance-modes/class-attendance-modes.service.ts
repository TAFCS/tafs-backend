import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';

export class SetClassAttendanceModeDto {
  class_id: number;
  mode: string; // 'BIOMETRIC_DAILY' | 'ROLL_CALL_SESSION'
}

@Injectable()
export class ClassAttendanceModesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    return this.prisma.class_attendance_modes.findMany({
      include: {
        classes: { select: { description: true, class_code: true } }
      }
    });
  }

  async findOneByClass(classId: number) {
    const mode = await this.prisma.class_attendance_modes.findUnique({
      where: { class_id: classId },
      include: {
        classes: { select: { description: true, class_code: true } }
      }
    });
    if (!mode) {
      throw new NotFoundException(`Attendance mode for class ID ${classId} not found`);
    }
    return mode;
  }

  async setMode(dto: SetClassAttendanceModeDto) {
    return this.prisma.class_attendance_modes.upsert({
      where: { class_id: dto.class_id },
      update: { mode: dto.mode },
      create: { class_id: dto.class_id, mode: dto.mode }
    });
  }

  async remove(classId: number) {
    await this.findOneByClass(classId);
    return this.prisma.class_attendance_modes.delete({
      where: { class_id: classId }
    });
  }
}
