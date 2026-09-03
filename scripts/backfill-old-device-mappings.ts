/**
 * Creates `device_user_mappings` rows for the staff who appear in the old
 * campus device's exports but have no biometric identity anywhere in the system.
 *
 * A mapping is unique on (device_sn, device_pin) and the processor resolves a
 * scan by looking up exactly that pair, so the old device's punches resolve to
 * nobody until these rows exist. Nothing else in the system creates them —
 * these four people were never enrolled on a live device at all.
 *
 * DRY RUN BY DEFAULT. Pass --commit to write.
 * Usage: npx ts-node scripts/backfill-old-device-mappings.ts [--commit]
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const COMMIT = process.argv.includes('--commit');

/**
 * The serial the imported scans are filed under. It is NOT 'MANUAL' — that is
 * excluded from scan resolution by design, which would leave every backfilled
 * punch looking like a permanent orphan in the audit.
 */
const DEVICE_SN = process.env.OLD_DEVICE_SN ?? 'OLDDEV-XLS';

const CREATED_BY = 'script:backfill-old-device-mappings';

/** Staff with punches in the plan and no mapping row anywhere. */
const MAPPINGS: { employee_id: number; device_pin: string; display_name: string }[] = [
  { employee_id: 143, device_pin: '1320', display_name: 'Ali asghar Mirz' },
  { employee_id: 216, device_pin: '4',    display_name: 'muhammadsohail' },
  { employee_id: 137, device_pin: '4504', display_name: 'syedaghazal' },
  { employee_id: 136, device_pin: '4505', display_name: 'habibuddin' },
  { employee_id: 323, device_pin: '4594', display_name: 'rimshawahab' },
];

async function main() {
  console.log(`device_sn: ${DEVICE_SN}`);
  console.log(COMMIT ? 'MODE: COMMIT — rows will be written\n' : 'MODE: DRY RUN — nothing will be written\n');

  let blocked = 0;
  const toWrite: typeof MAPPINGS = [];

  for (const m of MAPPINGS) {
    const emp = await prisma.employee_profiles.findUnique({
      where: { id: m.employee_id },
      select: { id: true, full_name: true, employee_code: true, employment_status: true },
    });
    if (!emp) { console.log(`  SKIP  employee ${m.employee_id} does not exist`); blocked++; continue; }

    const existingPair = await prisma.device_user_mappings.findUnique({
      where: { device_sn_device_pin: { device_sn: DEVICE_SN, device_pin: m.device_pin } },
    });
    const existingForEmp = await prisma.device_user_mappings.findMany({
      where: { employee_id: m.employee_id },
      select: { device_sn: true, device_pin: true, is_active: true },
    });

    // The service's collision guard BLOCKs a pin that is some student's CC or
    // GR number, because on a shared device that pin would credit their scans
    // to the wrong person. Report it rather than silently overriding.
    const pinNum = /^\d+$/.test(m.device_pin) ? Number(m.device_pin) : null;
    const clash = await prisma.students.findMany({
      where: { deleted_at: null, OR: [{ gr_number: m.device_pin }, ...(pinNum !== null ? [{ cc: pinNum }] : [])] },
      select: { cc: true, full_name: true, gr_number: true },
    });

    console.log(`  ${emp.full_name} [${emp.id}] ${emp.employee_code} (${emp.employment_status})`);
    console.log(`      -> ${DEVICE_SN} / pin ${m.device_pin}  "${m.display_name}"`);
    if (existingForEmp.length) console.log(`      note: already mapped on ${existingForEmp.map((x) => `${x.device_sn}:${x.device_pin}`).join(', ')}`);
    if (clash.length) console.log(`      WARN: pin is also ${clash.map((c) => `${c.full_name} (cc ${c.cc}, gr ${c.gr_number})`).join(', ')} — harmless here, this serial has no students on it`);
    if (existingPair) { console.log('      SKIP: this exact (device_sn, pin) already exists'); blocked++; continue; }

    toWrite.push(m);
  }

  console.log(`\n${toWrite.length} row(s) to create, ${blocked} skipped.`);
  if (!COMMIT) { console.log('\nDry run. Re-run with --commit to write.'); await prisma.$disconnect(); return; }

  const created = await prisma.$transaction(
    toWrite.map((m) =>
      prisma.device_user_mappings.create({
        data: {
          device_sn: DEVICE_SN,
          device_pin: m.device_pin,
          person_type: 'STAFF',
          employee_id: m.employee_id,
          display_name: m.display_name,
          notes: 'Old campus device, backfilled from 07/08Summary.xls',
          created_by: CREATED_BY,
        },
      }),
    ),
  );
  console.log(`\nWrote ${created.length} mapping(s):`);
  for (const c of created) console.log(`  #${c.id}  ${c.device_sn}/${c.device_pin} -> employee ${c.employee_id}`);
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
