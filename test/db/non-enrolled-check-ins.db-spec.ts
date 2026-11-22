/**
 * TAFSD-556: a biometric scan by a student who is no longer enrolled, end to end
 * through the real scan processor into a real Postgres, and the report through
 * the real guards.
 *
 * Covered: a LEFT student's scan still marks the day and is flagged beside it;
 * an enrolled student's scan is not flagged; reprocessing the same push adds no
 * second flag; the alert goes once, to a holder of `alerts` who can see the
 * student's campus and to every super admin; the report is closed without the tile, open with it, and
 * cut to the caller's campus; export needs its own tick.
 */
import type { INestApplication } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import type { PrismaService } from '../../prisma/prisma.service';
import { AccessService } from '../../src/modules/access/access.service';
import { ZkAttendanceProcessorService } from '../../src/modules/attendance/zk-attendance-processor.service';
import { bootApp, client, tokenFor } from './helpers/app';
import { CAMPUS_A, STUDENT, USERS, seedSchool } from './helpers/fixtures';

const TILE = 'attendance.non_enrolled_check_ins';
const SN = 'DBSUITE-SN';
const PATH = '/attendance/non-enrolled-check-ins';

let app: INestApplication;
let prisma: PrismaService;
let jwt: JwtService;
let processor: ZkAttendanceProcessorService;

/** Now, as the device would stamp it (Pakistan wall clock). */
function deviceNow(offsetMinutes = 0): { line: string; date: string } {
    const pkt = new Date(Date.now() + 5 * 3600_000 + offsetMinutes * 60_000);
    const iso = pkt.toISOString();
    return { line: `${iso.slice(0, 10)} ${iso.slice(11, 19)}`, date: iso.slice(0, 10) };
}

const push = (body: string) => processor.processPush({ sn: SN, query: { table: 'ATTLOG' }, body, pushLogId: null });

beforeAll(async () => {
    ({ app, prisma, jwt } = await bootApp());
    processor = app.get(ZkAttendanceProcessorService);
    await seedSchool(prisma);
    await prisma.$executeRawUnsafe(
        'TRUNCATE TABLE "attendance_non_enrolled_scans", "zk_attendance_scans", "attendance_student_daily", "device_user_mappings", "staff_notifications" RESTART IDENTITY CASCADE',
    );

    // A1 (campus A) and B1 (campus B) have left; A2 is still enrolled.
    await prisma.students.updateMany({ where: { cc: { in: [STUDENT.A1, STUDENT.B1] } }, data: { status: 'LEFT' } });
    await prisma.student_progression_periods.create({
        data: { student_cc: STUDENT.A1, campus_id: CAMPUS_A, change_type: 'LEFT', valid_from: new Date('2026-10-26T06:00:00Z') },
    });
    await prisma.device_user_mappings.createMany({
        data: [STUDENT.A1, STUDENT.A2, STUDENT.B1].map((cc) => ({
            device_sn: SN,
            device_pin: String(cc),
            person_type: 'STUDENT' as const,
            student_cc: cc,
        })),
    });

    // The campus-A clerk can open the report and asked for alerts; the viewer
    // (no campus scope) asked for nothing.
    await prisma.user_tile_grants.create({ data: { user_id: USERS.clerk.id, tile_id: TILE, allow: true, granted_by: USERS.admin.id } });
    await prisma.user_tile_action_grants.create({
        data: { user_id: USERS.clerk.id, tile_id: TILE, action_id: 'alerts', allow: true, granted_by: USERS.admin.id },
    });
});

afterAll(async () => {
    await app?.close();
});

describe('Not enrolled check-ins', () => {
    // Two scans five minutes apart (outside the 2-minute double-tap window).
    const now = deviceNow(-8);
    const later = deviceNow(-3);

    it('flags the LEFT students, still marks their day, and leaves the enrolled one alone', async () => {
        // Watch the normal path without changing it: whether a daily row is
        // written depends on the calendar (a Sunday run skips it), not on us.
        const daily = jest.spyOn(processor, 'upsertStudentDaily');
        await push([STUDENT.A1, STUDENT.A2, STUDENT.B1].map((cc) => `${cc}\t${now.line}\t0\t1\t0`).join('\n'));

        const flags = await prisma.attendance_non_enrolled_scans.findMany({ orderBy: { student_cc: 'asc' } });
        expect(flags.map((f) => [f.student_cc, f.student_status, f.campus_id])).toEqual([
            [STUDENT.A1, 'LEFT', CAMPUS_A],
            [STUDENT.B1, 'LEFT', 2],
        ]);
        expect(flags[0].left_at).toEqual(new Date('2026-10-26T06:00:00Z'));
        expect(flags[1].left_at).toBeNull();

        // Every scan still goes on to the daily attendance step, exactly as before.
        expect(daily.mock.calls.map((c) => c[0]).sort()).toEqual([STUDENT.A1, STUDENT.A2, STUDENT.B1].sort());
        daily.mockRestore();
        const scans = await prisma.zk_attendance_scans.findMany({ select: { student_cc: true, direction: true } });
        expect(scans).toHaveLength(3);
        expect(scans.every((x) => x.direction === 'IN')).toBe(true);
    });

    it('alerts once: the holder who can see the student, and every super admin', async () => {
        const alerts = await prisma.staff_notifications.findMany({ where: { kind: 'NON_ENROLLED_CHECK_IN' } });
        // The clerk only for campus A's student; the super admin (no tick) for both.
        expect(alerts.map((a) => `${a.user_id}:${a.entity_id}`).sort()).toEqual(
            [`${USERS.admin.id}:${STUDENT.A1}`, `${USERS.admin.id}:${STUDENT.B1}`, `${USERS.clerk.id}:${STUDENT.A1}`].sort(),
        );

        // A second scan later the same day is flagged but alerts nobody again.
        await push(`${STUDENT.A1}\t${later.line}\t0\t1\t0`);
        expect(await prisma.attendance_non_enrolled_scans.count({ where: { student_cc: STUDENT.A1 } })).toBe(2);
        expect(await prisma.staff_notifications.count({ where: { kind: 'NON_ENROLLED_CHECK_IN' } })).toBe(3);
    });

    it('reprocessing the same push adds no second flag', async () => {
        const before = await prisma.attendance_non_enrolled_scans.count();
        await push(`${STUDENT.A1}\t${now.line}\t0\t1\t0`);
        expect(await prisma.attendance_non_enrolled_scans.count()).toBe(before);
    });

    it('the report is closed without the tile', async () => {
        const res = await client(app, tokenFor(jwt, USERS.viewer)).get(`${PATH}?from=${now.date}`);
        expect(res.status).toBe(403);
    });

    it('with the tile it lists the caller’s campus only, one row per student per day', async () => {
        const res = await client(app, tokenFor(jwt, USERS.clerk)).get(`${PATH}?from=${now.date}&to=${now.date}`);
        expect(res.status).toBe(200);
        const rows = res.body.data.rows;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            student_cc: STUDENT.A1,
            status: 'LEFT',
            left_on: '2026-10-26',
            campus_id: CAMPUS_A,
            devices: [{ sn: SN, pin: String(STUDENT.A1) }],
            scans: 2,
        });
    });

    it('a SUPER_ADMIN sees every campus, and the search narrows by name, C.C. or G.R.', async () => {
        const admin = client(app, tokenFor(jwt, USERS.admin));
        const ccs = async (qs: string) =>
            (await admin.get(`${PATH}?from=${now.date}${qs}`)).body.data.rows.map((r: { student_cc: number }) => r.student_cc).sort();
        expect(await ccs('')).toEqual([STUDENT.A1, STUDENT.B1]);
        expect(await ccs(`&q=${STUDENT.B1}`)).toEqual([STUDENT.B1]);
        expect(await ccs('&q=campus%20b')).toEqual([STUDENT.B1]);
        expect(await ccs(`&q=GR-${STUDENT.A1}`)).toEqual([STUDENT.A1]);
        expect(await ccs('&q=nobody')).toEqual([]);
    });

    it('export needs its own tick', async () => {
        const clerk = client(app, tokenFor(jwt, USERS.clerk));
        expect((await clerk.get(`${PATH}/export?from=${now.date}`)).status).toBe(403);

        await prisma.user_tile_action_grants.create({
            data: { user_id: USERS.clerk.id, tile_id: TILE, action_id: 'export', allow: true, granted_by: USERS.admin.id },
        });
        app.get(AccessService).invalidateLiveSession(USERS.clerk.id);
        const res = await client(app, tokenFor(jwt, USERS.clerk)).get(`${PATH}/export?from=${now.date}`);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toContain('spreadsheetml');
    });
});
