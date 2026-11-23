import { ZkAttendanceMappingService } from './zk-attendance-mapping.service';
import { SEGMENT_IDS } from './zk-device-segment-rules';

// TAFSD-582: a student pin may only be mapped on a device that serves the
// student's segment, matched by segment id so renaming a segment's code
// (PRE_PRIMARY -> EARLY_YEARS) doesn't lock its students out.

const PRE_PRIMARY_DEVICE = 'NYU7261205128';
const TAFSAL = 'NYU7261205172';
const JOHAR_FACULTY = 'NYU7251000240';

const student = (campus_code: string, segment_id: number | null, segmentName: string) => ({
  full_name: 'ZAINAB',
  campuses: { campus_code, campus_name: campus_code },
  classes: { description: 'EARLY YEARS - II', segment_id, segments: segment_id ? { name: segmentName } : null },
});

function check(deviceSn: string, row: ReturnType<typeof student> | null) {
  const prisma = { students: { findUnique: jest.fn(async () => row) } };
  const service = new ZkAttendanceMappingService(prisma as any, {} as any, {} as any, {} as any);
  return (service as any).checkStudentDeviceEligibility(deviceSn, 6605);
}

describe('device segment eligibility (TAFSD-582)', () => {
  it('lets an Early Years student onto the Pre-Primary device, whatever the segment is coded now', async () => {
    expect(await check(PRE_PRIMARY_DEVICE, student('GEJ', SEGMENT_IDS.EARLY_YEARS, 'EARLY YEARS'))).toBeNull();
  });

  it('still refuses a Junior student there, as a hard block', async () => {
    const res = await check(PRE_PRIMARY_DEVICE, student('GEJ', SEGMENT_IDS.JUNIOR_CAMBRIDGE, 'JUNIOR CAMBRIDGE'));
    expect(res).toMatchObject({ code: 'DEVICE_SEGMENT_MISMATCH', severity: 'HARD_BLOCK' });
    expect(res.message).toContain('(JUNIOR CAMBRIDGE)');
  });

  it('refuses a student whose class has no segment on a segment-locked device', async () => {
    expect(await check(PRE_PRIMARY_DEVICE, student('GEJ', null, ''))).toMatchObject({ code: 'DEVICE_SEGMENT_MISMATCH' });
  });

  it('lets O-Level and A-Level students onto TAFSAL', async () => {
    expect(await check(TAFSAL, student('GEJ', SEGMENT_IDS.OLEVELS, 'O-LEVELS'))).toBeNull();
    expect(await check(TAFSAL, student('GEJ', SEGMENT_IDS.ALEVELS, 'A-LEVELS'))).toBeNull();
  });

  it('refuses a student from another campus, even in the right segment', async () => {
    expect(await check(PRE_PRIMARY_DEVICE, student('KNF', SEGMENT_IDS.EARLY_YEARS, 'EARLY YEARS'))).toMatchObject({
      code: 'DEVICE_SEGMENT_MISMATCH',
    });
  });

  it('faculty devices take any segment from their campus; unlisted devices are unrestricted', async () => {
    expect(await check(JOHAR_FACULTY, student('GEJ', SEGMENT_IDS.SECONDARY, 'SECONDARY'))).toBeNull();
    expect(await check('TEST-RIG', student('KNF', null, ''))).toBeNull();
  });
});
