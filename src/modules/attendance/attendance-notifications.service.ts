import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class AttendanceNotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async getForFamily(familyId: number, cursor?: number) {
    return this.prisma.attendance_notifications.findMany({
      where: {
        family_id: familyId,
        ...(cursor ? { id: { lt: cursor } } : {}),
      },
      orderBy: { created_at: 'desc' },
      include: {
        students: { select: { full_name: true } },
      },
      take: 20,
    });
  }

  async markRead(id: number, familyId: number) {
    const notification = await this.prisma.attendance_notifications.findFirst({
      where: { id, family_id: familyId },
    });
    if (!notification) throw new NotFoundException('Notification not found');

    return this.prisma.attendance_notifications.update({
      where: { id },
      data: { read_at: new Date() },
    });
  }
}
