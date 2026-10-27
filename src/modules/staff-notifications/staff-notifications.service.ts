import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../../../prisma/prisma.service';
import { FcmService } from '../../common/fcm/fcm.service';
import { ChatGateway } from '../chat/chat.gateway';
import { EmployeeNoticeBoardService } from '../employee-notice-board/employee-notice-board.service';

export type StaffNotificationInput = {
  /** What happened, e.g. NOTICE_APPROVED. */
  kind: string;
  title: string;
  body: string;
  /** Webapp path to open, e.g. /notice-board?post=12. */
  link?: string;
  entityType?: string;
  entityId?: string;
  /** Extra push data for a recipient without an employee profile. */
  pushData?: Record<string, string>;
};

/**
 * TAFSD-429: notifications addressed to one staff member. Each one is:
 * - stored, for the webapp's bell (with read / unread);
 * - sent live to their open webapp sessions over the socket;
 * - posted as a personal staff notice when they have an employee profile, so
 *   it lands in the staff app's notice inbox with a push that opens it;
 *   otherwise pushed to any staff app device they're logged into.
 */
@Injectable()
export class StaffNotificationsService {
  private readonly logger = new Logger(StaffNotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fcm: FcmService,
    private readonly employeeNotices: EmployeeNoticeBoardService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** Never throws: a notification failing must not undo what it reports. */
  async notify(userId: string, input: StaffNotificationInput): Promise<void> {
    try {
      const row = await this.prisma.staff_notifications.create({
        data: {
          user_id: userId,
          kind: input.kind,
          title: input.title,
          body: input.body,
          link: input.link ?? null,
          entity_type: input.entityType ?? null,
          entity_id: input.entityId ?? null,
        },
      });
      // Resolved lazily: the chat module depends on half the app, and this is
      // only ever a best-effort live nudge on top of the stored row.
      this.moduleRef.get(ChatGateway, { strict: false })?.emitToStaff(userId, 'staffNotification', row);
    } catch (err) {
      this.logger.error(`Could not store notification for ${userId}: ${(err as Error).message}`);
    }

    try {
      const employee = await this.prisma.employee_profiles.findFirst({
        where: { user_id: userId },
        select: { id: true },
      });
      if (employee) {
        await this.employeeNotices.createPersonalNotice(employee.id, userId, input.title, input.body, input.kind);
      } else {
        await this.fcm.sendToUsers([userId], input.title, input.body, { type: input.kind, ...input.pushData });
      }
    } catch (err) {
      this.logger.error(`Could not deliver notification to ${userId}: ${(err as Error).message}`);
    }
  }

  async list(userId: string, limit = 30) {
    const [items, unread] = await Promise.all([
      this.prisma.staff_notifications.findMany({
        where: { user_id: userId },
        orderBy: { created_at: 'desc' },
        take: Math.min(Math.max(limit, 1), 100),
      }),
      this.countUnread(userId),
    ]);
    return { items, unread };
  }

  countUnread(userId: string) {
    return this.prisma.staff_notifications.count({ where: { user_id: userId, read_at: null } });
  }

  async markRead(userId: string, id: number) {
    const { count } = await this.prisma.staff_notifications.updateMany({
      where: { id, user_id: userId, read_at: null },
      data: { read_at: new Date() },
    });
    if (!count) {
      const exists = await this.prisma.staff_notifications.count({ where: { id, user_id: userId } });
      if (!exists) throw new NotFoundException('Notification not found');
    }
  }

  async markAllRead(userId: string) {
    const { count } = await this.prisma.staff_notifications.updateMany({
      where: { user_id: userId, read_at: null },
      data: { read_at: new Date() },
    });
    return count;
  }
}
