import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { auditActorLabel } from '../../common/utils/audit-actor.util';
import { isTemplateDisabled, resolveTemplate } from '../../utils/notification-templates.util';
import { NoticeBoardService } from '../notice-board/notice-board.service';
import { FinancialReportsService } from './financial-reports.service';
import type { ListDefaultersQueryDto } from './dto/financial-report-query.dto';

/**
 * TAFSD-384: "Notify through app" on the Defaulters report. Posts a
 * notice-board notice to one student's family, worded by the
 * notif_fee_defaulter_* templates on Notification Templates.
 *
 * Figures are always recomputed here through listDefaulters (with the
 * caller's scope), never taken from the client, so a notice can only quote
 * what the report itself says about that student as of that date.
 */
export const DEFAULTER_TITLE_KEY = 'notif_fee_defaulter_title';
export const DEFAULTER_BODY_KEY = 'notif_fee_defaulter_body';
export const DEFAULT_DEFAULTER_TITLE = 'Outstanding School Fees';
export const DEFAULT_DEFAULTER_BODY =
  'Dear Parent, {student_name} ({gr_number}, {class_name}) has outstanding school fees of {outstanding_amount}, ' +
  'pending since {oldest_month}. Please clear the balance at the earliest. If you have already paid, please ignore this notice.';

type DefaulterItem = {
  cc: number;
  gr_number: string | null;
  student_name: string | null;
  campus: string;
  class_name: string;
  section: string;
  months_behind: number;
  arrears_outstanding: number;
  lps_outstanding?: number;
  oldest_arrear_month_label?: string | null;
};

function pkr(amount: number): string {
  return `Rs. ${Math.round(amount).toLocaleString('en-PK')}`;
}

function todayPkt(): string {
  return new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);
}

@Injectable()
export class DefaulterNotifyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reports: FinancialReportsService,
    private readonly noticeBoard: NoticeBoardService,
  ) {}

  private async loadRow(cc: number, asOfDate: string | undefined, user: IJwtStaffPayload): Promise<{ row: DefaulterItem; asOf: string }> {
    const asOf = asOfDate ?? todayPkt();
    const result = (await this.reports.listDefaulters(
      { cc, view: 'students', as_of_date: asOf, page: 1, limit: 1 } as ListDefaultersQueryDto,
      user,
    )) as { items?: DefaulterItem[] };
    const row = result.items?.[0];
    if (!row) {
      throw new BadRequestException(`This student is not on the defaulters list as of ${asOf}, so there is nothing to notify.`);
    }
    return { row, asOf };
  }

  private async render(row: DefaulterItem) {
    const arrears = Number(row.arrears_outstanding ?? 0);
    const lateFee = Number(row.lps_outstanding ?? 0);
    const vars: Record<string, string> = {
      student_name: row.student_name ?? `Student ${row.cc}`,
      gr_number: row.gr_number ?? `CC ${row.cc}`,
      class_name: [row.class_name, row.section].filter(Boolean).join(' ') || '—',
      campus_name: row.campus || '—',
      outstanding_amount: pkr(arrears + lateFee),
      arrears_amount: pkr(arrears),
      late_fee_amount: pkr(lateFee),
      months_behind: String(row.months_behind),
      oldest_month: row.oldest_arrear_month_label || 'this month',
    };
    const [title, body] = await Promise.all([
      resolveTemplate(this.prisma, DEFAULTER_TITLE_KEY, DEFAULT_DEFAULTER_TITLE, vars),
      resolveTemplate(this.prisma, DEFAULTER_BODY_KEY, DEFAULT_DEFAULTER_BODY, vars),
    ]);
    return { title, body, arrears: arrears + lateFee };
  }

  private async history(cc: number) {
    const rows = await this.prisma.defaulter_notifications.findMany({
      where: { student_id: cc },
      orderBy: { sent_at: 'desc' },
      take: 5,
      select: { sent_at: true, sent_by_name: true, arrears_outstanding: true, notice_post_id: true },
    });
    return rows.map((r) => ({ ...r, arrears_outstanding: Number(r.arrears_outstanding) }));
  }

  /** The exact notice that "Send" would post, plus earlier sends. Read-only. */
  async preview(cc: number, asOfDate: string | undefined, user: IJwtStaffPayload) {
    const { row, asOf } = await this.loadRow(cc, asOfDate, user);
    const [{ title, body }, previous, disabled] = await Promise.all([
      this.render(row),
      this.history(cc),
      isTemplateDisabled(this.prisma, DEFAULTER_TITLE_KEY),
    ]);
    return { cc, student_name: row.student_name, as_of_date: asOf, title, body, disabled, previous };
  }

  async send(cc: number, asOfDate: string | undefined, user: IJwtStaffPayload) {
    if (await isTemplateDisabled(this.prisma, DEFAULTER_TITLE_KEY)) {
      throw new BadRequestException('Fee defaulter notices are switched off on the Notification Templates page.');
    }
    const { row, asOf } = await this.loadRow(cc, asOfDate, user);
    const { title, body, arrears } = await this.render(row);

    // Copy is fixed by the template, and it goes to exactly one student, so
    // it skips the super-admin review queue (decided 19 Oct 2026).
    const post = await this.noticeBoard.createPost(
      user.sub,
      { title, body, student_ccs: [cc] },
      auditActorLabel(user),
      user,
      { skipReview: true },
    );
    const record = await this.prisma.defaulter_notifications.create({
      data: {
        student_id: cc,
        notice_post_id: post.id,
        sent_by: user.sub,
        sent_by_name: auditActorLabel(user),
        arrears_outstanding: new Prisma.Decimal(arrears.toFixed(2)),
        months_behind: row.months_behind,
        as_of_date: new Date(`${asOf}T00:00:00.000Z`),
      },
    });
    return {
      cc,
      notice_post_id: post.id,
      sent_at: record.sent_at,
      sent_by_name: record.sent_by_name,
      families_reached: post.total_reached,
      title,
      body,
    };
  }
}
