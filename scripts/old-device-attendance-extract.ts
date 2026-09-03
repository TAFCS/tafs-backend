/**
 * Read-only extractor for the standalone (unlinked) ZKTeco device exports in
 * `old-device-attendance/`. Parses the "List of Logs" grid into flat punches.
 *
 * The grid is one row per device user, one column per day-of-month, and each
 * cell holds that day's punches as newline-separated HH:MM values. Device PINs
 * are meaningless here, so the Name column is the only identity we get — and
 * the device truncates it to 15 characters.
 *
 * Writes nothing to the DB. Usage: npx ts-node scripts/old-device-attendance-extract.ts
 */
import * as XLSX from 'xlsx';
import { join } from 'path';

export interface DevicePunch {
  file: string;
  devicePin: string;
  rawName: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
}

export interface DeviceUser {
  file: string;
  devicePin: string;
  rawName: string;
  nameLooksTruncated: boolean;
  punchCount: number;
  dayCount: number;
}

const DIR = join(__dirname, '../old-device-attendance');

const FILES: { file: string; year: number; month: number }[] = [
  { file: '07Summary.xls', year: 2026, month: 7 },
  { file: '08Summary.xls', year: 2026, month: 8 },
];

function parseSheet(file: string, year: number, month: number) {
  const wb = XLSX.readFile(join(DIR, file));
  const ws = wb.Sheets['Logs'];
  const rows: string[][] = XLSX.utils.sheet_to_json(ws, {
    header: 1,
    raw: false,
    defval: '',
  });

  // Row 2 is the day-of-month header, row 3 the weekday header, data from row 4.
  const dayHeader = rows[2].map((v) => String(v ?? '').trim());
  const dayCols: { col: number; day: number }[] = [];
  for (let c = 2; c < dayHeader.length; c++) {
    const d = Number(dayHeader[c]);
    if (Number.isInteger(d) && d >= 1 && d <= 31) dayCols.push({ col: c, day: d });
  }

  const punches: DevicePunch[] = [];
  const users: DeviceUser[] = [];

  for (let r = 4; r < rows.length; r++) {
    const row = rows[r];
    const pin = String(row[0] ?? '').trim();
    const name = String(row[1] ?? '').trim();
    if (!pin && !name) continue;

    // A blank Name shifts the whole day grid one column left in the export.
    const nameIsPunchBlob = /^\d{1,2}:\d{2}/.test(name);
    const shift = nameIsPunchBlob ? -1 : 0;
    const effectiveName = nameIsPunchBlob ? '' : name;

    let punchCount = 0;
    const days = new Set<string>();
    for (const { col, day } of dayCols) {
      const cell = String(row[col + shift] ?? '').trim();
      if (!cell) continue;
      const times = cell
        .split(/\r?\n/)
        .map((t) => t.trim())
        .filter((t) => /^\d{1,2}:\d{2}$/.test(t));
      if (times.length === 0) continue;
      const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      days.add(date);
      for (const time of times) {
        punches.push({
          file,
          devicePin: pin,
          rawName: effectiveName,
          date,
          time: time.padStart(5, '0'),
        });
        punchCount++;
      }
    }

    users.push({
      file,
      devicePin: pin,
      rawName: effectiveName,
      // The device caps the exported name at 15 chars; anything at the cap is
      // suspect and must be matched as a prefix, not an equality.
      nameLooksTruncated: effectiveName.length >= 15,
      punchCount,
      dayCount: days.size,
    });
  }

  return { punches, users };
}

export function extractAll() {
  const punches: DevicePunch[] = [];
  const users: DeviceUser[] = [];
  for (const { file, year, month } of FILES) {
    const out = parseSheet(file, year, month);
    punches.push(...out.punches);
    users.push(...out.users);
  }
  return { punches, users };
}

if (require.main === module) {
  const { punches, users } = extractAll();
  const withData = users.filter((u) => u.punchCount > 0);
  console.log(`device users listed:      ${users.length}`);
  console.log(`device users with punches:${withData.length}`);
  console.log(`punches:                  ${punches.length}`);
  console.log(`nameless users w/ punches:${withData.filter((u) => !u.rawName).length}`);
  console.log(`truncated names w/ punches:${withData.filter((u) => u.nameLooksTruncated).length}`);
  const dates = [...new Set(punches.map((p) => p.date))].sort();
  console.log(`date range: ${dates[0]} .. ${dates[dates.length - 1]} (${dates.length} days)`);
  console.log('\nsample:');
  for (const u of withData.slice(0, 15)) console.log('  ', JSON.stringify(u));
}
