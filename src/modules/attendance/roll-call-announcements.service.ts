import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ChatGateway } from '../chat/chat.gateway';

@Injectable()
export class RollCallAnnouncementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly chatGateway: ChatGateway,
  ) {}

  async isEnabled(campusId: number, ruleType: string): Promise<boolean> {
    const policySet = await this.prisma.hr_policy_sets.findFirst({
      where: { campus_id: campusId },
      orderBy: { effective_from: 'desc' },
      include: {
        hr_policy_rules: { where: { rule_type: ruleType } },
      },
    });
    const rule = policySet?.hr_policy_rules?.[0];
    if (!rule?.value_json || typeof rule.value_json !== 'object') {
      return true;
    }
    const val = rule.value_json as { enabled?: boolean };
    return val.enabled !== false;
  }

  async announceSessionTaken(sessionId: number): Promise<void> {
    const session = await this.prisma.attendance_roll_sessions.findUnique({
      where: { id: sessionId },
      include: {
        classes: true,
        sections: true,
        attendance_roll_records: {
          include: {
            students: {
              select: { cc: true, full_name: true, family_id: true },
            },
          },
        },
      },
    });
    if (!session?.classes) return;

    const enabled = await this.isEnabled(session.campus_id, 'ANNOUNCE_ROLLCALL_TAKEN');
    if (!enabled) return;

    const dateStr = session.session_date.toISOString().slice(0, 10);
    const gradeCode = session.classes.class_code;
    const sectionDesc = session.sections?.description ?? '';

    // Send a per-student family-scoped announcement for each marked student
    for (const record of session.attendance_roll_records) {
      const student = record.students;
      if (!student?.family_id) continue;

      const statusLabel = record.status === 'PRESENT' ? 'Present' : 'Absent';
      const content = `Period ${session.period} (${dateStr}) — ${student.full_name}: ${statusLabel}`;

      await this.chatGateway.publishFamilyAnnouncement(
        student.family_id,
        content,
        gradeCode,
        sectionDesc,
      );
    }
  }

  async announceSessionSkipped(sessionId: number): Promise<void> {
    const session = await this.prisma.attendance_roll_sessions.findUnique({
      where: { id: sessionId },
      include: {
        classes: true,
        sections: true,
        teaching_groups: { include: { subjects: true } },
      },
    });
    if (!session?.classes) return;

    const enabled = await this.isEnabled(session.campus_id, 'ANNOUNCE_ROLLCALL_SKIPPED');
    if (!enabled) return;

    const dateStr = session.session_date.toISOString().slice(0, 10);
    const reason = session.skip_reason ? ` Reason: ${session.skip_reason}` : '';
    const scopeLabel = session.teaching_groups
      ? session.teaching_groups.subjects.name
      : `Section ${session.sections?.description ?? ''}`;
    const content = `Roll call was not taken for ${session.classes.class_code} ${scopeLabel} (Period ${session.period}, ${dateStr}).${reason}`;

    await this.chatGateway.publishAnnouncement({
      content,
      targetGrade: session.classes.class_code,
      targetSection: session.sections?.description ?? undefined,
    });
  }
}
