import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ScopeService } from '../../common/scope/scope.service';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';

@Injectable()
export class StudentFlagsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly scope: ScopeService,
  ) {}

  /** 404 unless the student is in the caller's scope — flags carry no placement of their own. */
  async assertStudentVisible(user: IJwtStaffPayload, studentId: number): Promise<void> {
    if (this.scope.isExempt(user)) return;
    const visible = await this.prisma.students.count({
      where: { cc: studentId, ...this.scope.whereForStudents(user) },
    });
    if (!visible) throw new NotFoundException(`Student #${studentId} not found`);
  }

  async onModuleInit() {
    // Never block listen() on DDL. DROP/CREATE TRIGGER needs an ACCESS EXCLUSIVE
    // lock — under load that waited forever, so Railway never got a bound port
    // and every route (including healthz) timed out with 0 bytes.
    void this.setupTrigger();
  }

  // ── TRIGGER SETUP ────────────────────────────────────────────────────────
  // Idempotent: skip when the trigger already exists. DDL only on first boot.
  private async setupTrigger() {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ exists: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM pg_trigger WHERE tgname = 'trg_student_flag_notify'
        ) AS "exists"
      `;
      if (rows[0]?.exists) return;

      await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '3s'`);
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '5s'`);
          await tx.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION public.notify_student_flag()
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
          await tx.$executeRawUnsafe(`
      DROP TRIGGER IF EXISTS trg_student_flag_notify ON public.student_flags;
    `);
          await tx.$executeRawUnsafe(`
      CREATE TRIGGER trg_student_flag_notify
      AFTER INSERT OR UPDATE ON public.student_flags
      FOR EACH ROW EXECUTE FUNCTION public.notify_student_flag();
    `);
        },
        { maxWait: 3000, timeout: 8000 },
      );
    } catch (err) {
      // Concurrent Nest reloads can race on CREATE OR REPLACE FUNCTION.
      console.error('[StudentFlags] Trigger setup skipped (non-fatal):', err);
    }
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────

  async addFlag(studentId: number, flag: string, reminderDate: Date | undefined, changedBy: string) {
    const existing = await this.prisma.student_flags.findUnique({
      where: {
        student_id_flag: {
          student_id: studentId,
          flag: flag,
        },
      },
    });
    const result = await this.prisma.student_flags.upsert({
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

    void this.auditLogs.log({
      entity_type: 'STUDENT_FLAG',
      entity_id: `${studentId}:${flag}`,
      action: existing ? 'UPDATED' : 'CREATED',
      changed_by: changedBy,
      student_id: studentId,
      note: `Flag "${flag}"${reminderDate ? ` with reminder ${reminderDate.toISOString().slice(0, 10)}` : ''} for student CC ${studentId}.`,
    });

    return result;
  }

  async markWorkDone(studentId: number, flag: string, changedBy: string) {
    const result = await this.prisma.student_flags.update({
      where: {
        student_id_flag: {
          student_id: studentId,
          flag: flag,
        },
      },
      data: { work_done: true },
    });

    void this.auditLogs.log({
      entity_type: 'STUDENT_FLAG',
      entity_id: `${studentId}:${flag}`,
      action: 'RESOLVED',
      changed_by: changedBy,
      student_id: studentId,
      note: `Flag "${flag}" marked as done for student CC ${studentId}.`,
    });

    return result;
  }

  async removeFlag(studentId: number, flag: string, changedBy: string) {
    const result = await this.prisma.student_flags.deleteMany({
      where: { student_id: studentId, flag },
    });

    void this.auditLogs.log({
      entity_type: 'STUDENT_FLAG',
      entity_id: `${studentId}:${flag}`,
      action: 'DELETED',
      changed_by: changedBy,
      student_id: studentId,
      note: `Flag "${flag}" removed for student CC ${studentId}.`,
    });

    return result;
  }

  async getFlags(studentId: number) {
    return this.prisma.student_flags.findMany({
      where: { student_id: studentId },
      select: { flag: true, reminder_date: true, work_done: true, created_at: true },
    });
  }

  // ── NOTIFICATIONS ────────────────────────────────────────────────────────

  async getPendingNotifications(user: IJwtStaffPayload) {
    const students = await this.prisma.students.findMany({
      where: {
        ...this.scope.whereForStudents(user),
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

  /** Badge count only — avoids shipping the full notification list to the header. */
  async countPendingNotifications(user: IJwtStaffPayload): Promise<number> {
    return this.prisma.student_flags.count({
      where: {
        work_done: false,
        OR: [{ reminder_date: { lte: new Date() } }, { reminder_date: null }],
        students: {
          deleted_at: null,
          ...this.scope.whereForStudents(user),
        },
      },
    });
  }
}
