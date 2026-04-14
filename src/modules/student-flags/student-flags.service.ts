import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class StudentFlagsService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.setupTrigger();
  }

  // ── TRIGGER SETUP ────────────────────────────────────────────────────────
  // This keeps the DB logic firing even without a live NestJS listener.
  private async setupTrigger() {
    await this.prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION notify_student_flag()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.work_done = false THEN
          PERFORM pg_notify(
            'student_flag_alert',
            json_build_object(
              'student_id', NEW.student_id,
              'flag',       NEW.flag,
              'reminder_date', NEW.reminder_date,
              'created_at', NEW.created_at
            )::text
          );
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await this.prisma.$executeRawUnsafe(`
      DROP TRIGGER IF EXISTS trg_student_flag_notify ON student_flags;
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE TRIGGER trg_student_flag_notify
      AFTER INSERT OR UPDATE ON student_flags
      FOR EACH ROW EXECUTE FUNCTION notify_student_flag();
    `);
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────

  async addFlag(studentId: number, flag: string, reminderDate?: Date) {
    return this.prisma.student_flags.upsert({
      where: {
        student_id_flag: {
          student_id: studentId,
          flag: flag,
        },
      },
      create: { 
        student_id: studentId, 
        flag, 
        reminder_date: reminderDate,
        work_done: false
      },
      update: {
        reminder_date: reminderDate,
        work_done: false
      },
    });
  }

  async markWorkDone(studentId: number, flag: string) {
    return this.prisma.student_flags.update({
      where: {
        student_id_flag: {
          student_id: studentId,
          flag: flag,
        },
      },
      data: { work_done: true },
    });
  }

  async removeFlag(studentId: number, flag: string) {
    return this.prisma.student_flags.deleteMany({
      where: { student_id: studentId, flag },
    });
  }

  async getFlags(studentId: number) {
    return this.prisma.student_flags.findMany({
      where: { student_id: studentId },
      select: { flag: true, reminder_date: true, work_done: true, created_at: true },
    });
  }

  // ── NOTIFICATIONS ────────────────────────────────────────────────────────

  async getPendingNotifications() {
    const students = await this.prisma.students.findMany({
      where: {
        student_flags: {
          some: {
            work_done: false,
            OR: [
              { reminder_date: { lte: new Date() } },
              { reminder_date: null }
            ]
          }
        },
        deleted_at: null,
      },
      select: {
        cc: true,
        full_name: true,
        doa: true,
        classes: { select: { description: true } },
        student_flags: {
          where: { 
            work_done: false,
            OR: [
              { reminder_date: { lte: new Date() } },
              { reminder_date: null }
            ]
          },
          select: { id: true, flag: true, reminder_date: true, created_at: true }
        },
      },
    });

    const notifications: any[] = [];
    students.forEach(s => {
      s.student_flags.forEach(f => {
        notifications.push({
          id: f.id,
          student_id: s.cc,
          student_name: s.full_name,
          current_class: s.classes?.description,
          doa: s.doa,
          flag: f.flag,
          reminder_date: f.reminder_date,
          message: f.flag.includes('fast_track') 
            ? `Fast Track promotion due for ${s.full_name}.`
            : `Notification for ${s.full_name}: ${f.flag}`
        });
      });
    });

    return notifications;
  }
}
