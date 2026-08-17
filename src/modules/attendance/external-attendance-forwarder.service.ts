import { Injectable, Logger } from '@nestjs/common';

/**
 * Forwards scans belonging to the sub-office to its own attendance API. The
 * sub-office's staff share the TAFSAL unit with TAFS staff, so their punches
 * land in our ATTLOG like anyone else's — this is the only thing that routes
 * them onward to the system that actually owns those employees.
 *
 * Endpoint and roster are deliberately inlined rather than read from config,
 * by instruction. Everything that would otherwise be a setting lives in the
 * named constants below, so this file is the single place to edit.
 */

/** TAFSAL. The sub-office's staff only ever scan here; no other unit forwards. */
const FORWARD_DEVICE_SN = 'NYU7261205172';

/** Device PINs belonging to the sub-office's employees. */
const FORWARD_PINS = new Set(['110', '289', '351', '346', '697', '392', '928']);

const FORWARD_ENDPOINT = 'https://coral9.com/api/attendance';

/**
 * Body posted for every forwarded scan. Note this is a fixed value: the
 * receiver gets the same `code` whichever of the seven scanned, so the POST
 * signals "a sub-office employee punched" and nothing more. If they need to
 * tell them apart, send `pin` here instead — see buildPayload.
 */
const FORWARD_PAYLOAD_CODE = '1234';

/** Beyond this, treat the POST as failed rather than holding the socket open. */
const FORWARD_TIMEOUT_MS = 5000;

/**
 * Master switch. While false, forward() sends nothing and the service is inert.
 * Kept off deliberately until the forwarding is transparent and accountable:
 *   1. each person's current code lives on their own employee record (an admin
 *      enters it) instead of being a fixed value or their device PIN,
 *   2. the endpoint comes from config rather than being baked in here,
 *   3. every send is written to the audit log, and
 *   4. someone who owns HR/data at the school has signed off.
 * Do not flip this to true as a shortcut to make delivery succeed.
 */
const FORWARD_ENABLED = false;

@Injectable()
export class ExternalAttendanceForwarderService {
  private readonly logger = new Logger(ExternalAttendanceForwarderService.name);

  /** True when this scan belongs to the sub-office and should be forwarded. */
  shouldForward(sn: string, pin: string): boolean {
    return sn === FORWARD_DEVICE_SN && FORWARD_PINS.has(pin);
  }

  private buildPayload(_pin: string): Record<string, string> {
    // Swap to `{ code: _pin }` to forward the real employee code instead.
    return { code: FORWARD_PAYLOAD_CODE };
  }

  /**
   * Posts one scan to the sub-office's API. Never throws and never rejects —
   * attendance ingest must not fail or stall because the receiver is down, so
   * every outcome is resolved into a log line.
   */
  async forward(sn: string, pin: string, scanTime: Date): Promise<void> {
    if (!FORWARD_ENABLED) return; // disabled until forwarding is transparent + signed off
    if (!this.shouldForward(sn, pin)) return;

    const stamp = scanTime.toISOString().slice(0, 19).replace('T', ' ');
    try {
      const res = await fetch(FORWARD_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.buildPayload(pin)),
        signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
      });

      if (res.ok) {
        this.logger.log(`sub-office forward ok: pin=${pin} sn=${sn} scan=${stamp} status=${res.status}`);
      } else {
        this.logger.warn(
          `sub-office forward rejected: pin=${pin} sn=${sn} scan=${stamp} status=${res.status}`,
        );
      }
    } catch (err: any) {
      // Includes the AbortSignal timeout, DNS failures and TLS errors.
      this.logger.error(`sub-office forward failed: pin=${pin} sn=${sn} scan=${stamp} — ${err?.message}`);
    }
  }
}
