/**
 * Cross-checks student device_user_mappings against the segment each biometric
 * device is assigned to (Campus 2/3 devices were renamed to carry a segment
 * suffix — see tafs-webapp/src/lib/zk-devices.ts). Flags any active student
 * mapping whose class's segment doesn't match the device's segment.
 *
 * Usage: npx ts-node scripts/check-student-device-segment.ts
 */
import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { DEVICE_SEGMENT_RULES } from '../src/modules/attendance/zk-device-segment-rules';

const prisma = new PrismaClient();

const CSV_PATH = join(__dirname, '../../student-device-segment-audit.csv');

// Segment-scoped devices and the segments each serves: the same rule the
// mapping screen enforces (TAFSD-582: matched by segment id, since codes can be
// renamed). Faculty devices serve every segment and are skipped.
const LABELS: Record<string, string> = {
  NYU7261205142: 'Campus 3 Device 1 Junior Cambridge',
  NYU7261205128: 'Campus 3 Device 2 Pre-Primary',
  NYU7261205141: 'Campus 2 Device 2 Senior Cambridge',
  NYU7261205221: 'Campus 2 Device 1 Secondary',
  NYU7261205172: 'TAFSAL',
};

function csvEscape(value: string | number | boolean | null): string {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const deviceSns = Object.keys(DEVICE_SEGMENT_RULES);

  const mappings = await prisma.device_user_mappings.findMany({
    where: { person_type: 'STUDENT', student_cc: { not: null }, device_sn: { in: deviceSns } },
    select: {
      id: true,
      device_sn: true,
      device_pin: true,
      is_active: true,
      student_cc: true,
      students: {
        select: {
          cc: true,
          full_name: true,
          gr_number: true,
          class_id: true,
          classes: { select: { id: true, description: true, class_code: true, segment_id: true, segments: { select: { code: true, name: true } } } },
        },
      },
    },
    orderBy: [{ device_sn: 'asc' }, { id: 'asc' }],
  });

  console.log(`Scanned ${mappings.length} student mapping(s) across ${deviceSns.length} segment-scoped device(s).\n`);

  const mismatches: typeof mappings = [];
  const unclassed: typeof mappings = [];

  for (const sn of deviceSns) {
    const label = LABELS[sn] ?? sn;
    const { segmentIds } = DEVICE_SEGMENT_RULES[sn];
    const rows = mappings.filter((m) => m.device_sn === sn);
    console.log(`=== ${sn} — ${label} (expects segment ${segmentIds.join(' / ')}) — ${rows.length} student mapping(s) ===`);
    for (const m of rows) {
      const cls = m.students?.classes;
      const segId = cls?.segment_id ?? null;
      const clsDesc = cls?.description ?? '(no class)';
      const line = `  cc=${m.student_cc} | ${m.students?.full_name ?? '?'} (GR ${m.students?.gr_number ?? '—'}) | class=${clsDesc} | segment=${cls?.segments?.name ?? '—'} | pin=${m.device_pin} | active=${m.is_active}`;
      if (segId == null) {
        unclassed.push(m);
        console.log(line + '  [NO SEGMENT ON CLASS]');
      } else if (!segmentIds.includes(segId)) {
        mismatches.push(m);
        console.log(line + '  [MISMATCH]');
      } else {
        console.log(line);
      }
    }
    if (rows.length === 0) console.log('  none');
    console.log('');
  }

  console.log(`Summary: ${mismatches.length} wrong-device mapping(s), ${unclassed.length} mapping(s) with no class/segment set.`);

  const header = ['device_sn', 'device_label', 'expected_segment', 'actual_segment', 'mapping_id', 'student_cc', 'gr_number', 'student_name', 'class', 'device_pin', 'is_active'];
  const rows: string[][] = [];
  for (const m of [...mismatches, ...unclassed]) {
    const cls = m.students?.classes;
    rows.push([
      m.device_sn,
      LABELS[m.device_sn] ?? m.device_sn,
      DEVICE_SEGMENT_RULES[m.device_sn].segmentIds.join(' / '),
      cls?.segment_id != null ? `${cls.segment_id} ${cls.segments?.name ?? ''}`.trim() : '',
      String(m.id),
      String(m.student_cc),
      m.students?.gr_number ?? '',
      m.students?.full_name ?? '',
      cls?.description ?? '',
      m.device_pin,
      String(m.is_active),
    ]);
  }
  const csv = [header, ...rows].map((r) => r.map(csvEscape).join(',')).join('\n');
  writeFileSync(CSV_PATH, csv + '\n');
  console.log(`CSV written to ${CSV_PATH} (${rows.length} flagged row(s)).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
