import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

/**
 * Drives Coral9's scheduled jobs from here.
 *
 * Coral9 runs on Vercel, whose cron scheduling isn't available to us, so the
 * jobs live on this box instead — it is already always-on and already talks to
 * Coral9 for attendance. Both endpoints are plain authenticated GETs that do
 * their own work; this class only decides WHEN, never what.
 *
 * Lives in the attendance module beside Coral9AttendanceWriterService: that is
 * already the Coral9 integration's home here, and one of the two jobs is the
 * backstop for the mail that writer triggers.
 *
 * CONFIG. CORAL9_CRON_SECRET must equal CRON_SECRET on Coral9, and has to be
 * passed through docker-compose to reach the container. Without it both jobs
 * log and do nothing rather than firing unauthenticated requests.
 *
 * SAFE UNDER MULTIPLE REPLICAS. If this service runs on more than one replica
 * they will all fire, and that is fine: every Coral9 job claims its work
 * against a unique index before doing anything (one digest per project per
 * kind per local date; one email per punch). A duplicate call finds the claim
 * taken and returns having done nothing. No leader election needed.
 */

const CORAL9_BASE = 'https://www.coral9.com';
const CORAL9_CRON_SECRET = process.env.CORAL9_CRON_SECRET ?? '';

/**
 * Generous, because the digest renders a board PDF per due project. Still
 * bounded — a hung request must not pin a worker until the next tick.
 */
const CALL_TIMEOUT_MS = 120_000;

@Injectable()
export class Coral9SchedulerService {
  private readonly logger = new Logger(Coral9SchedulerService.name);

  /** Guards against a slow run overlapping the next tick. */
  private readonly running = new Set<string>();

  /**
   * Client board digests — the 8am briefing and 10pm wrap-up.
   *
   * HOURLY IS NOT NEGOTIABLE, and it is worth understanding why: the send time
   * is 8am and 10pm in each CLIENT'S OWN timezone. 8am in Karachi and 8am in
   * Detroit are ten hours apart, so no fixed pair of daily runs can serve both.
   * Coral9 handles the per-client decision — every hour it asks each client
   * "is it your 8am or your 10pm?" — so all this has to do is wake it up on
   * the hour, every hour.
   *
   * The server's own timezone is irrelevant for the same reason: an hour
   * boundary is an hour boundary wherever this process happens to run.
   */
  @Cron(CronExpression.EVERY_HOUR, { name: 'coral9-client-digest' })
  async clientDigest(): Promise<void> {
    await this.call('/api/cron/client-digest', 'client digest');
  }

  /**
   * Backstop for the attendance clock-in/out emails.
   *
   * Normally redundant: the attendance writer pings Coral9 the moment a punch
   * commits, so mail goes out in about a second. This only matters when that
   * ping never lands — this service restarting mid-scan, a dropped connection,
   * a deploy in flight. Ten minutes is late for a "welcome in" message but far
   * better than never.
   */
  @Cron('*/10 * * * *', { name: 'coral9-attendance-mail' })
  async attendanceMail(): Promise<void> {
    await this.call('/api/cron/attendance-mail', 'attendance mail');
  }

  /**
   * One authenticated GET. Never throws — a scheduled job that throws can take
   * the scheduler down with it, and none of this work is worth that.
   */
  private async call(path: string, label: string): Promise<void> {
    if (!CORAL9_CRON_SECRET) {
      this.logger.error(`${label} skipped: CORAL9_CRON_SECRET is not set`);
      return;
    }

    // A previous run is still going. Skipping is correct rather than queueing:
    // the next tick does the same work, and the jobs are idempotent anyway.
    if (this.running.has(path)) {
      this.logger.warn(`${label} skipped: previous run still in flight`);
      return;
    }
    this.running.add(path);

    const startedAt = Date.now();
    try {
      const res = await fetch(`${CORAL9_BASE}${path}`, {
        headers: { Authorization: `Bearer ${CORAL9_CRON_SECRET}` },
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });

      const body = await res.text().catch(() => '');
      const ms = Date.now() - startedAt;

      if (res.ok) {
        // Coral9 returns counts, e.g. {"considered":2,"sent":2,"skipped":0}.
        // Logging the body is what makes "did anything actually go out?"
        // answerable without opening their dashboard.
        this.logger.log(`${label} ok in ${ms}ms — ${body}`);
      } else {
        // 401 = secret mismatch. 503 = CRON_SECRET unset on their side.
        this.logger.warn(`${label} rejected in ${ms}ms: status=${res.status} body=${body}`);
      }
    } catch (err: any) {
      this.logger.error(
        `${label} failed after ${Date.now() - startedAt}ms — ${err?.message}`,
      );
    } finally {
      this.running.delete(path);
    }
  }
}
