import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

/**
 * Writes sub-office (Coral9) scans straight into the Coral9 database.
 *
 * Replaces ExternalAttendanceForwarderService, which POSTed to
 * https://coral9.com/api/attendance. Same job, one less hop: the attendance
 * device can only hold a single backend URL, so every scan lands in the TAFS
 * ATTLOG and this is what routes the Coral9 employees' scans onward.
 *
 * ---------------------------------------------------------------------------
 * THE PUNCH RULE — this must stay identical to Coral9's own implementation
 * (src/lib/attendance.ts there), because both write the same table.
 *
 *   Punches within one local day alternate, starting with a check-in:
 *     seq 1 -> in    seq 2 -> out    seq 3 -> in    seq 4 -> out ...
 *
 *   Odd punches open a work session, even ones close it. The gap between an
 *   even punch and the next odd one IS the break — nothing is ever recorded as
 *   a break, which is why a scan carries no in/out intent. The Nth scan of the
 *   day already knows what it is.
 *
 *   "Day" is the local calendar date in Asia/Karachi, frozen into work_date at
 *   insert time — NOT the server's date, which is UTC and rolls over five hours
 *   early.
 * ---------------------------------------------------------------------------
 *
 * Never throws and never rejects: attendance ingest must not fail or stall
 * because the Coral9 database is unreachable. Every outcome becomes a log line.
 *
 * Requires CORAL9_DATABASE_URL — the coral9_attendance_writer role's connection
 * string from the grant script, not the project's owner/postgres role. Set it
 * via the deploy platform's secret manager; it must never be hardcoded here.
 * Inert (forward() is a no-op) until that env var is set.
 *
 * CORAL9_FLUSH_SECRET is optional: without it the punch still writes, it just
 * waits on Coral9's cron sweep to mail instead of firing immediately.
 */

/** TAFSAL. Coral9 staff only ever scan here; no other unit forwards. */
const FORWARD_DEVICE_SN = 'NYU7261205172';

/**
 * Device PINs belonging to Coral9 employees.
 *
 * These ARE the Coral9 attendance codes — the two systems were deliberately
 * given the same values, so a PIN is written through as the code with no
 * mapping table. Adding an employee means adding their code here AND on the
 * device; Coral9 issues the code.
 *
 *   110 Aawaiz Ali      289 Hassan Mirza    351 Umer Noor    346 Shuja ur Rahman
 *   697 Bilal           392 Fahad           928 Hashir
 *
 * 472 (Zaki Kazmi) intentionally omitted pending confirmation he's Coral9 and
 * not TAFS — add him here once confirmed.
 */
const FORWARD_PINS = new Set(['110', '289', '351', '346', '697', '392', '928']);

/**
 * Coral9's Postgres. Use the SCOPED role (coral9_attendance_writer), not the
 * application's own connection string — this service has no business reading
 * users' password hashes or the secrets vault. Supabase transaction pooler
 * (port 6543) is the right endpoint for a long-lived service like this.
 */
const CORAL9_DATABASE_URL = process.env.CORAL9_DATABASE_URL ?? '';

/** The clock that defines a "day". Must match Coral9's ATTENDANCE_TZ. */
const CORAL9_TZ = 'Asia/Karachi';

/**
 * A second scan inside this window is folded into the first.
 *
 * Without it, someone badging twice at the door checks straight back out, and
 * nobody notices until payroll. Must match Coral9's DEBOUNCE_SECONDS.
 */
const DEBOUNCE_SECONDS = 90;

/** Account types that hold an attendance code. Clients never punch. */
const STAFF_ACCOUNT_TYPES = ['superadmin', 'platform_admin', 'internal'];

/** Beyond this, give up rather than hold the ingest path open. */
const STATEMENT_TIMEOUT_MS = 5000;

/**
 * Tells Coral9 to send the clock-in/out email immediately.
 *
 * The database write cannot send mail, and waiting for Coral9's cron sweep put
 * a "welcome in" message minutes behind the person walking through the door.
 * This ping closes that gap.
 *
 * Deliberately fire-and-forget and deliberately best-effort: the punch is
 * already committed before this runs, so a failure here costs a timely email
 * and nothing else — Coral9's cron still picks the punch up as a backstop.
 * Never let it delay or fail the scan.
 */
const CORAL9_FLUSH_URL = 'https://www.coral9.com/api/attendance/flush';
const CORAL9_FLUSH_SECRET = process.env.CORAL9_FLUSH_SECRET ?? '';
const CORAL9_FLUSH_TIMEOUT_MS = 3000;

interface PunchOutcome {
  userFound: boolean;
  fullName: string | null;
  /** Seconds since the previous punch today, null when this is the first. */
  sinceLast: number | null;
  newSeq: number | null;
  newKind: 'in' | 'out' | null;
}

@Injectable()
export class Coral9AttendanceWriterService implements OnModuleDestroy {
  private readonly logger = new Logger(Coral9AttendanceWriterService.name);

  /**
   * Small on purpose. This writes a handful of rows a day; a large pool against
   * someone else's database is just holding connections they need elsewhere.
   * Constructed lazily so a missing CORAL9_DATABASE_URL doesn't throw at
   * module init — it just means shouldForward-gated calls stay no-ops.
   */
  private pool: Pool | null = CORAL9_DATABASE_URL
    ? new Pool({
        connectionString: CORAL9_DATABASE_URL,
        ssl: { rejectUnauthorized: false }, // Supabase terminates TLS at the pooler
        max: 2,
        idleTimeoutMillis: 10_000,
        connectionTimeoutMillis: STATEMENT_TIMEOUT_MS,
        statement_timeout: STATEMENT_TIMEOUT_MS,
      })
    : null;

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end().catch(() => undefined);
  }

  /** True when this scan belongs to Coral9 and should be written through. */
  shouldForward(sn: string, pin: string): boolean {
    return sn === FORWARD_DEVICE_SN && FORWARD_PINS.has(pin);
  }

  /**
   * Record one scan as the next punch of that person's local day.
   *
   * The whole decision — who the code belongs to, what number punch this is,
   * whether it is an in or an out, and whether it is a double-tap to ignore —
   * happens in ONE statement. That matters across a network boundary: a
   * read-then-write would leave a window where two scans both believe they are
   * punch N, and the loser would be silently dropped.
   */
  async forward(sn: string, pin: string, scanTime: Date): Promise<void> {
    if (!this.shouldForward(sn, pin)) return;
    const stamp = scanTime.toISOString().slice(0, 19).replace('T', ' ');

    if (!this.pool) {
      this.logger.error(`coral9 punch skipped: CORAL9_DATABASE_URL is not set (pin=${pin})`);
      return;
    }

    try {
      // One retry only, for the unique-violation case below.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const outcome = await this.writePunch(pin, sn);

          if (!outcome.userFound) {
            this.logger.warn(
              `coral9 punch rejected: pin=${pin} sn=${sn} scan=${stamp} — no active staff account holds this code`,
            );
            return;
          }

          if (outcome.newSeq === null) {
            this.logger.log(
              `coral9 punch ignored (double scan ${Math.round(outcome.sinceLast ?? 0)}s apart): ` +
                `${outcome.fullName} pin=${pin} scan=${stamp}`,
            );
            return;
          }

          this.logger.log(
            `coral9 punch ok: ${outcome.fullName} ${outcome.newKind === 'in' ? 'checked IN' : 'checked OUT'} ` +
              `(punch #${outcome.newSeq}) pin=${pin} sn=${sn} scan=${stamp}`,
          );

          // Not awaited: the punch is safe in the database, and the scan must
          // not wait on Coral9's mail path. A dropped ping only means the email
          // arrives on their next cron sweep instead of now.
          void this.pingCoral9(pin);
          return;
        } catch (err: any) {
          // 23505 = unique_violation on (user_id, work_date, seq): a concurrent
          // scan claimed this slot first. Recomputing seq is the whole fix.
          if (err?.code === '23505' && attempt === 0) continue;
          throw err;
        }
      }
    } catch (err: any) {
      // Includes connection failures, statement timeouts and TLS errors.
      this.logger.error(
        `coral9 punch failed: pin=${pin} sn=${sn} scan=${stamp} — ${err?.message}`,
      );
    }
  }

  /**
   * Nudge Coral9 to send the email for whatever it hasn't mailed yet.
   *
   * Sends no punch id — it is a trigger, not a message. Coral9 drains its own
   * queue, so a ping that arrives twice, late, or after an earlier one failed
   * all end in the same correct state, and neither side has to agree on what
   * "this punch" means.
   *
   * Swallows every error by design. This is the one call in the path that is
   * allowed to fail silently, because the thing that matters is already saved.
   */
  private async pingCoral9(pin: string): Promise<void> {
    if (!CORAL9_FLUSH_SECRET) return; // not configured — cron will cover it

    try {
      const res = await fetch(CORAL9_FLUSH_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${CORAL9_FLUSH_SECRET}` },
        signal: AbortSignal.timeout(CORAL9_FLUSH_TIMEOUT_MS),
      });
      if (!res.ok) {
        this.logger.warn(
          `coral9 mail ping rejected: pin=${pin} status=${res.status} — email will follow on their cron`,
        );
      }
    } catch (err: any) {
      this.logger.warn(
        `coral9 mail ping failed: pin=${pin} — ${err?.message}. Email will follow on their cron.`,
      );
    }
  }

  private async writePunch(pin: string, sn: string): Promise<PunchOutcome> {
    const { rows } = await this.pool!.query(
      `
      with tz as (
        select (now() at time zone $2)::date as work_date
      ),
      usr as (
        select u.id, u.full_name
        from users u
        where u.attendance_code = $1
          and u.deleted_at is null
          and u.is_active = true
          and u.account_type = any($3::text[])
      ),
      last as (
        select p.seq, p.at
        from attendance_punches p, usr, tz
        where p.user_id = usr.id and p.work_date = tz.work_date
        order by p.seq desc
        limit 1
      ),
      ins as (
        insert into attendance_punches
          (user_id, work_date, seq, kind, source, user_agent)
        select
          usr.id,
          tz.work_date,
          coalesce((select seq from last), 0) + 1,
          -- Odd punch opens a session, even one closes it.
          case when (coalesce((select seq from last), 0) + 1) % 2 = 1
               then 'in' else 'out' end,
          'api',
          $4
        from usr, tz
        -- No row here means: unknown code (usr empty), or a double scan inside
        -- the debounce window. Both are correctly "write nothing".
        where not exists (
          select 1 from last
          where now() - last.at < make_interval(secs => $5)
        )
        returning seq, kind
      )
      select
        (select count(*) from usr)::int                                as user_count,
        (select full_name from usr)                                    as full_name,
        (select extract(epoch from (now() - at))::float from last)     as since_last,
        ins.seq                                                        as new_seq,
        ins.kind                                                       as new_kind
      from (values (1)) v(x)
      left join ins on true
      `,
      [pin, CORAL9_TZ, STAFF_ACCOUNT_TYPES, `tafs-device ${sn}`, DEBOUNCE_SECONDS],
    );

    const r = rows[0] ?? {};
    return {
      userFound: Number(r.user_count ?? 0) > 0,
      fullName: r.full_name ?? null,
      sinceLast: r.since_last ?? null,
      newSeq: r.new_seq ?? null,
      newKind: r.new_kind ?? null,
    };
  }
}
