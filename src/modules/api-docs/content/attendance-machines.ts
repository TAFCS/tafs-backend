import { ZK_DEVICES, WARN_MINUTES, ALERT_MINUTES, CRITICAL_MINUTES, WINDOW_START_HOUR, WINDOW_END_HOUR } from '../../attendance/zk-device-health.util';
import { DEVICE_CAMPUS_ONLY_RULES, DEVICE_SEGMENT_RULES, SEGMENT_IDS } from '../../attendance/zk-device-segment-rules';
import type { ApiDoc } from '../api-docs.types';

/**
 * TAFSD-614: the attendance machine (ZKTeco ADMS push) API, as the backend
 * implements it today. Sources: zk-push.controller.ts, zk-push.service.ts,
 * zk-attendance-processor.service.ts, zk-attendance-mapping.service.ts,
 * zk-device-segment-rules.ts, zk-device-health.util.ts and main.ts.
 *
 * The device table is read from ZK_DEVICES and the rule maps, so it cannot
 * drift. The prose can: re-check it when those files change, and update the
 * matching docs/api-docs/attendance-machines.tex and its PDF in the same PR.
 */

const SEGMENT_NAME: Record<number, string> = {
  [SEGMENT_IDS.EARLY_YEARS]: 'Early Years',
  [SEGMENT_IDS.JUNIOR_CAMBRIDGE]: 'Junior Cambridge',
  [SEGMENT_IDS.SENIOR_CAMBRIDGE]: 'Senior Cambridge',
  [SEGMENT_IDS.OLEVELS]: 'O Levels',
  [SEGMENT_IDS.ALEVELS]: 'A Levels',
  [SEGMENT_IDS.SECONDARY]: 'Secondary',
};

function studentRule(sn: string): string {
  const seg = DEVICE_SEGMENT_RULES[sn];
  if (seg) return `${seg.campusCode} students in ${seg.segmentIds.map((id) => SEGMENT_NAME[id] ?? `segment ${id}`).join(' / ')}`;
  const campus = DEVICE_CAMPUS_ONLY_RULES[sn];
  if (campus) return `Any ${campus} student`;
  return 'No check';
}

const deviceRows = Object.entries(ZK_DEVICES).map(([sn, d]) => [
  `\`${sn}\``,
  d.name,
  d.campusCode,
  d.activeOnSaturday ? 'Yes' : 'No',
  studentRule(sn),
]);

export const ATTENDANCE_MACHINES_DOC: ApiDoc = {
  slug: 'attendance-machines',
  title: 'Attendance Machines API',
  subtitle: 'ZKTeco biometric devices pushing punches to TAFSync (ADMS / iclock)',
  version: '1.0',
  updated: '2026-11-27',
  summary:
    'How the campus fingerprint and face devices send every punch to the backend, what each endpoint accepts and returns, how a device serial and PIN become an employee or a student, and the quirks found in the code.',
  pdfFile: 'attendance-machines.pdf',
  downloadName: 'TAFS_API_Attendance_Machines.pdf',
  sections: [
    {
      id: 'overview',
      title: 'Overview',
      blocks: [
        {
          type: 'p',
          text: 'Each campus has ZKTeco biometric devices (NYU series, and SenseFace models on Push v3 firmware). They speak ZKTeco\'s **ADMS push protocol**: the device opens every connection, TAFS never polls it. The device registers, fetches its settings, then posts each punch as it happens and polls about once a minute for commands.',
        },
        {
          type: 'list',
          ordered: true,
          items: [
            'The raw request is stored in `zk_push_logs` (body capped at 64,000 characters). It shows under **ZK Device Logs → Raw logs**.',
            'An `ATTLOG` push is parsed line by line into `zk_attendance_scans`, one row per punch.',
            'The pair (device serial, PIN) is looked up in `device_user_mappings` to find the employee or student.',
            'That person\'s day is rebuilt: IN/OUT directions, `attendance_staff_daily` or `attendance_student_daily`.',
            'A **live** punch notifies the employee (Staff App) or the student\'s parents. Backfill never notifies.',
          ],
        },
        { type: 'p', text: 'Devices TAFS knows about (`ZK_DEVICES` in `zk-device-health.util.ts`):' },
        { type: 'table', head: ['Serial', 'Name', 'Campus', 'Used on Saturday', 'Students it may map'], rows: deviceRows },
        {
          type: 'note',
          tone: 'info',
          text: 'Device names are their on-box labels. "Campus 2" and "Campus 3" devices are physically at the Johar (GEJ) campus, so the campus column comes from scan history, not the label.',
        },
      ],
    },
    {
      id: 'setup',
      title: 'Setting up a device',
      blocks: [
        {
          type: 'p',
          text: 'Every endpoint lives under the API\'s global prefix, so the device must reach `https://api.tafs.cloud/api/v1/iclock/…`. The `/api/v1` prefix has applied to these routes since 30 June 2026.',
        },
        {
          type: 'list',
          ordered: true,
          items: [
            'On the device, open the cloud server (ADMS) settings under the communication menu. Set the server address to the TAFSync API host and turn on the domain-name option.',
            'Set the device clock to Pakistan time (UTC+05:00). Punch times are stored exactly as the device reports them, and the server sends a `Date` header on `registry`, `cdata` and `regstable` for the device to sync from.',
            'Add the serial to `ZK_DEVICES` (`zk-device-health.util.ts`), and to `DEVICE_SEGMENT_RULES` or `DEVICE_CAMPUS_ONLY_RULES` (`zk-device-segment-rules.ts`) if students will use it. Keep the webapp\'s `zk-devices.ts` in step. Until then the device works, but it gets no health tile and no student eligibility check.',
            'Enrol people on the device. A student\'s PIN must be their CC. An employee\'s PIN can be anything, then map it (next section).',
            'Check **ZK Device Logs → Raw logs**: a `registry` row, then `cdata` rows. Unknown PINs appear under unmapped PINs, with the name the device reports.',
          ],
        },
        {
          type: 'note',
          tone: 'warn',
          text: 'Menu wording differs between firmware versions, and some models do not accept a path in the server address. Confirm on the model being installed that its requests arrive at `/api/v1/iclock/…` (Raw logs shows the first `registry` row) before handing it over.',
        },
      ],
    },
    {
      id: 'authentication',
      title: 'Authentication',
      blocks: [
        {
          type: 'p',
          text: 'There is **none**. Device firmware cannot send credentials, so the `/iclock/*` routes are open. A device is identified only by the `SN` query parameter (`sn` is also accepted; a request with neither is logged as `unknown`).',
        },
        {
          type: 'list',
          items: [
            'A punch from an unknown serial, or an unmapped PIN, is stored but credited to nobody.',
            'A forged request carrying a real serial and a mapped PIN would be credited. Nothing in the protocol prevents it; keep the URL out of public material.',
            'Bodies are read as plain text whatever the `Content-Type`, up to **2 MB** (`main.ts`). Larger bodies are refused by the server with HTTP 413.',
            'Maintenance mode does not block these routes (`app-maintenance.guard.ts`).',
          ],
        },
      ],
    },
    {
      id: 'endpoints',
      title: 'Endpoints',
      blocks: [
        {
          type: 'p',
          text: 'Base path `https://api.tafs.cloud/api/v1/iclock`. Every route answers HTTP 200 with a `text/plain` body. Failures inside TAFS are logged, never returned: the device always gets its `OK` so it does not retry forever.',
        },
        {
          type: 'table',
          head: ['Method', 'Path', 'Sent by the device when', 'Response'],
          rows: [
            ['POST', '`/registry?SN=…`', 'It starts up (ADMS v2 / Push v3)', '`OK` + `Date` header'],
            ['GET', '`/cdata?SN=…&options=all`', 'It asks for its settings', 'Settings block (below)'],
            ['POST', '`/regstable?SN=…`', 'Push v3: it declares its tables', '`OK` + `Date` header'],
            ['POST', '`/cdata?SN=…&table=ATTLOG`', 'It sends punches, user changes, photos', '`OK`'],
            ['GET', '`/getrequest?SN=…`', 'It polls for commands (about every 60 s)', '`OK`, or one command'],
            ['POST', '`/devicecmd?SN=…`', 'It reports a command\'s result', '`OK`'],
            ['POST', '`/querydata?SN=…`', 'Some Push v3 firmware answers a data query here', '`OK` (logged raw only)'],
          ],
        },
      ],
      subsections: [
        {
          id: 'registry',
          title: 'POST /registry',
          blocks: [
            { type: 'p', text: 'Body: comma-separated `key=value` pairs describing the hardware and firmware. Stored raw. The reply must be exactly `OK`; anything else is not a valid ADMS v2 command and makes the device retry indefinitely.' },
            { type: 'code', title: 'Request', code: 'POST /api/v1/iclock/registry?SN=NYU7251000240\n\nDeviceType=acc,~DeviceName=NYU,FirmVer=…,PushVersion=…' },
            { type: 'code', title: 'Response', code: 'HTTP/1.1 200 OK\nContent-Type: text/plain\nDate: Fri, 27 Nov 2026 03:00:00 GMT\n\nOK' },
          ],
        },
        {
          id: 'cdata-get',
          title: 'GET /cdata (settings)',
          blocks: [
            { type: 'p', text: 'The reply is fixed. Each line matters to some firmware:' },
            {
              type: 'code',
              title: 'Response',
              code: 'OK\nStamp=0\nATTLOGStamp=0\nOPERLOGStamp=0\nATTPHOTOStamp=0\nDelay=60\nTransFlag=TransData AttLog OpLog AttPhoto\nTimeOut=10\nRealtime=1\nEncrypt=None\nPushOptionsFlag=1',
            },
            {
              type: 'list',
              items: [
                '`Stamp=0` and the per-table stamps tell the device to send everything it holds from the beginning. Without them, devices with `LogIDFunOn=1` (SenseFace 2A) never enter the push phase. The cost is a full backfill after every settings fetch, which the duplicate rules below make harmless.',
                '`Realtime=1` sends each punch as it happens; `Delay=60` is the batch interval otherwise.',
                '`PushOptionsFlag=1` must be echoed for Push v3 firmware, or it loops back to `registry`.',
              ],
            },
          ],
        },
        {
          id: 'cdata-post',
          title: 'POST /cdata (punches and other tables)',
          blocks: [
            {
              type: 'p',
              text: 'The `table` query parameter says what the body holds. TAFS answers `OK` straight away and processes the body afterwards, because a backfill can carry thousands of lines and a slow reply makes the device resend. At most two pushes are processed at once.',
            },
            {
              type: 'table',
              head: ['table', 'What TAFS does'],
              rows: [
                ['`ATTLOG`', 'Each line becomes a punch (format below).'],
                ['`OPERLOG`', 'Lines like `USER PIN=16\\tName=Ali Khan\\t…` save the device\'s name for that PIN in `zk_pin_name_hints`. Used only to suggest names on the unmapped-PIN screen.'],
                ['anything else', '`USERINFO`, `ATTPHOTO`, `BIOPHOTO`, …: stored raw in `zk_push_logs`, nothing more.'],
              ],
            },
            { type: 'p', text: 'An `ATTLOG` line is tab-separated, in one of two layouts. TAFS tells them apart by where the date-time sits:' },
            {
              type: 'code',
              title: 'ATTLOG body',
              code: '# LogIDFunOn=0 (ADMS v1):  PIN  DateTime  Status  Verify  WorkCode\n8088\t2026-11-27 07:42:15\t0\t1\t0\n\n# LogIDFunOn=1 (ADMS v2):  LogID  PIN  DateTime  Status  Verify  WorkCode\n10452\t8088\t2026-11-27 07:42:15\t0\t1\t0',
            },
            {
              type: 'table',
              head: ['Field', 'Stored as', 'Notes'],
              rows: [
                ['PIN', '`device_pin`', 'Required. With the serial, decides who punched.'],
                ['DateTime', '`scan_time`', '`YYYY-MM-DD HH:MM:SS`, device wall clock, stored as written (no time-zone conversion).'],
                ['Status', '`device_status`', 'The device\'s in/out key. Stored, but **not used**: direction is worked out by TAFS.'],
                ['Verify', '`verify_mode`', 'How the person was verified (finger, face, card…). Stored only.'],
                ['WorkCode', '`work_code`', 'Stored only.'],
              ],
            },
            { type: 'p', text: 'A line with no PIN or an unreadable date-time is skipped silently.' },
          ],
        },
        {
          id: 'getrequest',
          title: 'GET /getrequest and POST /devicecmd (commands)',
          blocks: [
            {
              type: 'p',
              text: 'TAFS can queue **one** command per device, held in memory. The next poll receives it as `C:<id>:<command>`; otherwise the reply is `OK`. The device reports the result to `devicecmd`, which is stored with a `DEVICECMD` prefix in the raw logs. A newer command replaces one never picked up, and a restart drops whatever is queued.',
            },
            { type: 'code', title: 'Poll with a command waiting', code: 'GET /api/v1/iclock/getrequest?SN=NYU7251000240\n\nC:482113:DATA QUERY ATTLOG StartTime=2026-11-27 00:00:00\tEndTime=2026-11-27 23:59:59' },
            { type: 'code', title: 'Result', code: 'POST /api/v1/iclock/devicecmd?SN=NYU7251000240\n\nID=482113&Return=0&CMD=DATA' },
            { type: 'p', text: '`Return=0` means success. The only command TAFS sends today is the nightly re-send request described under Known quirks.' },
          ],
        },
      ],
    },
    {
      id: 'mapping',
      title: 'From serial and PIN to a person',
      blocks: [
        {
          type: 'p',
          text: 'A PIN means nothing on its own: the same number can be different people on different devices. `device_user_mappings` holds one row per **(device serial, PIN)**, unique, pointing at either an employee (`person_type = STAFF`, `employee_id`) or a student (`STUDENT`, `student_cc`). Someone enrolled on three devices needs three rows.',
        },
        {
          type: 'list',
          items: [
            'An inactive mapping, or none, leaves the punch stored but credited to nobody. It shows on the unmapped-PIN screen.',
            'Creating, editing, deactivating or deleting a mapping re-credits **every past punch** on that serial and PIN, then rebuilds the affected days. It runs inline for up to 2,000 punches. Beyond that the mapping is saved, history is not rebuilt, and the response says to call `POST /api/v1/attendance/zk-scan-resolution/resolve` with `{"kind":"device_pin","device_sn":"…","device_pin":"…","dry_run":false}`.',
            'Posting over a deactivated mapping is refused (409) unless `is_active: true` is sent.',
            'Mappings are managed in **ZK Device Logs** (mappings, unmapped PINs, PIN lookup) and in the biometric tabs of the Employee and Student directories.',
          ],
        },
        { type: 'p', text: 'Checks run when a mapping is saved. A hard block cannot be overridden; a block or warning can be acknowledged with `acknowledge_collisions`.' },
        {
          type: 'table',
          head: ['Code', 'Level', 'Meaning'],
          rows: [
            ['`PIN_NOT_EQUAL_TO_CC`', 'Hard block', 'A student\'s PIN must equal their CC.'],
            ['`DEVICE_SEGMENT_MISMATCH`', 'Hard block', 'The student\'s campus or segment is not one this device serves (device table above).'],
            ['`PIN_IS_OTHER_STUDENT_CC`', 'Block', 'The PIN is another student\'s CC; their punches would be credited here.'],
            ['`PIN_IS_OTHER_STUDENT_GR`', 'Block', 'The PIN is another student\'s GR number. GR numbers and CCs share one number space.'],
            ['`PIN_USED_ON_OTHER_DEVICE`', 'Warning', 'The same PIN is mapped to a different person on another device.'],
          ],
        },
      ],
    },
    {
      id: 'processing',
      title: 'How a punch is processed',
      blocks: [
        {
          type: 'table',
          head: ['Rule', 'Detail'],
          rows: [
            ['Exact duplicate', 'Unique key (serial, PIN, time). A punch already stored is dropped before anything else runs, so replaying a whole day is safe.'],
            ['Double tap', 'A punch within **2 minutes** of the same person\'s last accepted punch, on any device, is kept with `is_duplicate = true` and does not change their IN/OUT sequence.'],
            ['Live or backfill', 'A punch within **10 minutes** of the current Pakistan time is live (`is_live`). Only live punches notify anyone, and only live punches go to Coral9\'s attendance feed.'],
            ['Staff direction', 'Strict alternation through the day: 1st IN, 2nd OUT, 3rd IN, …'],
            ['Student direction', 'Against the class\'s internal **intermediate time**: every punch before it is an IN (only the first is the arrival), the first at or after it is an OUT, later ones alternate. Classes with no intermediate time fall back to alternation.'],
            ['Student lateness', 'Paused: `STUDENT_LATE_MARKING_ENABLED = false`, so every student arrival counts as PRESENT.'],
            ['Protected days', 'A student day on leave, or marked by hand or by the system as anything but ABSENT, is not overwritten by a punch. A default ABSENT mark is.'],
            ['Left students', 'A punch by a student who is LEFT, EXPELLED or GRADUATED is processed normally and also flagged for the Not Enrolled check-ins report.'],
            ['Parent notice', 'Sent for the first arrival and for departures. Repeat taps before the intermediate time are silent.'],
          ],
        },
      ],
    },
    {
      id: 'quirks',
      title: 'Known quirks',
      blocks: [
        {
          type: 'table',
          head: ['Quirk', 'What to know'],
          rows: [
            ['Clock skew', 'Times are taken as the device states them. A device whose clock drifts shifts its punches by the same amount. The old standalone campus device ran **2 minutes behind** Johar Faculty (`NYU7251000240`), measured over 2,649 punches seen on both. The 2-minute double-tap window uses a strict `<`, so it does not catch a skew of exactly 2 minutes: de-duplicate such imports per person per day, never per timestamp.'],
            ['`OLDDEV-XLS`', 'Synthetic serial reserved for back-filling the old standalone device\'s Excel export (27 Jul – 30 Aug 2026), with times shifted **+2 minutes** to match. Each person needs a mapping on this serial; 5 exist. As of 27 Nov 2026 no punches have been imported under it.'],
            ['`MANUAL`', 'Pseudo-serial for gate-desk check-ins a staff member punches in the webapp for a student with no biometric enrolment. They run through the same pipeline (directions, parent notices); the serial is what tells them apart. Re-crediting never touches these rows.'],
            ['Full backfill on reconnect', '`Stamp=0` makes a device resend all it holds after each settings fetch. Duplicates are dropped by the unique key; raw bodies over 64,000 characters are truncated in `zk_push_logs` (the punches themselves are all processed).'],
            ['Devices that never flush', 'On 12 Sep 2026 the API was down 05:3x–10:44 PKT. Four devices sent their queued punches on reconnect; Johar Faculty and GKF Faculty did not. Trial fix: every day at 23:00 PKT TAFS queues `DATA QUERY ATTLOG` for that day on those two devices only (`zk-device-resend-scheduler.service.ts`).'],
            ['Push v3 firmware', 'Needs `PushOptionsFlag=1` echoed in the settings and a 200 on `regstable`. Either missing sends it back to `registry` in a loop.'],
            ['Device health', `Expected to talk Monday to Saturday, ${String(WINDOW_START_HOUR).padStart(2, '0')}:00–${WINDOW_END_HOUR}:00 PKT. After ${WARN_MINUTES} minutes of silence the tile shows a warning, after ${ALERT_MINUTES} an alert, after ${CRITICAL_MINUTES} critical. On Saturdays only the faculty devices and TAFSAL are expected. Last contact includes the minute-by-minute polls, which are kept in memory only, so straight after a restart health falls back to the last stored push.`],
            ['Three device lists', '`ZK_DEVICES`, the `DEVICE_*_RULES` maps and the webapp\'s `zk-devices.ts` must be edited together.'],
          ],
        },
      ],
    },
    {
      id: 'errors',
      title: 'Error codes',
      blocks: [
        {
          type: 'p',
          text: 'The device endpoints have no error codes: every accepted request gets HTTP 200 and `OK`. The only failures a device can see come from the web server itself:',
        },
        {
          type: 'table',
          head: ['HTTP', 'When'],
          rows: [
            ['200', 'Every request to a known `/iclock` route, including ones whose processing failed (see the server log and Raw logs).'],
            ['404', 'A route TAFS does not implement. Firmware that gets one typically falls back to `registry`.'],
            ['413', 'Body larger than 2 MB.'],
          ],
        },
        {
          type: 'p',
          text: 'The staff-facing mapping routes under `/api/v1/attendance/zk-device-mappings` return the codes in the mapping section with HTTP 409, and 400 for a STAFF mapping without `employee_id` or a STUDENT mapping without `student_cc`.',
        },
      ],
    },
    {
      id: 'testing',
      title: 'Testing',
      blocks: [
        {
          type: 'p',
          text: 'There is no sandbox: every device and every test talks to production.',
        },
        {
          type: 'list',
          items: [
            '**Simulate scan** (ZK Device Logs, action `attendance.zk_device_logs#simulate`, `POST /api/v1/attendance/zk-device-mappings/simulate-scan` with `device_sn`, `device_pin`, optional `scan_time`) runs one punch through the real pipeline and returns the stored punch and the rebuilt day.',
            'To try the raw protocol, post to `/cdata` with a made-up serial. Its punches stay unmapped and change nobody\'s attendance.',
          ],
        },
        {
          type: 'code',
          title: 'Raw protocol test with a made-up serial',
          code: "curl -X POST 'https://api.tafs.cloud/api/v1/iclock/cdata?SN=TEST-DEVICE-01&table=ATTLOG' \\\n  --data-binary $'99999\\t2026-11-27 09:00:00\\t0\\t1\\t0'",
        },
        {
          type: 'note',
          tone: 'warn',
          text: 'Simulate scan always notifies, even for a past time. With a real serial and a mapped PIN it marks that person\'s real attendance and messages them or their parents. Use a test student or an unmapped PIN.',
        },
      ],
    },
  ],
};
