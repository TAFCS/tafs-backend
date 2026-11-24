/**
 * Student Directory: a student's lifecycle. Status changes (left, expelled,
 * graduated), bringing a student back (undo left, unexpel, reinstate,
 * readmit), permanent deletion, and promotion (single, bulk, graduate/leave in
 * bulk) with GR suggestions.
 */
import { CAMPUS_A, CAMPUS_B, CLASS_AUG, SECTION, STUDENT, YEAR } from '../helpers/fixtures';
import { CLASS_VII, FAMILY, HOUSE, waitForAudit } from './directory-fixtures';
import { directorySuite } from './suite';

const ctx = directorySuite();

const student = (cc: number) => ctx.prisma.students.findUniqueOrThrow({ where: { cc } });
const openPeriod = async (cc: number) =>
    (await ctx.prisma.student_progression_periods.findMany({ where: { student_cc: cc, valid_to: null } }))[0];
const setStatus = (who: keyof typeof ctx.as, cc: number, body: object) => ctx.as[who].patch(`/students/${cc}/status`).send(body);

describe('changing status (PATCH /students/:id/status)', () => {
    it('marks a student as left, with a reason, a log flag, a progression period and an audit row', async () => {
        const res = await setStatus('dirClerk', STUDENT.A1, { status: 'LEFT', reason: 'Family moved abroad' });
        expect(res.status).toBe(200);
        expect((await student(STUDENT.A1)).status).toBe('LEFT');
        expect((await openPeriod(STUDENT.A1)).change_type).toBe('LEFT');

        const [flag] = await ctx.prisma.student_flags.findMany({ where: { student_id: STUDENT.A1 } });
        expect(flag).toMatchObject({ work_done: true, comment: 'Family moved abroad' });
        expect(flag.flag).toMatch(/^LEFT_LOG_\d+$/);

        const audit = await ctx.prisma.audit_logs.findMany({ where: { student_id: STUDENT.A1, action: 'STATUS_CHANGED' } });
        expect(audit).toEqual([expect.objectContaining({ old_value: 'ENROLLED', new_value: 'LEFT', changed_by: 'dbsuite.dirclerk' })]);
    });

    it('graduates a student: the class moves to graduated_from_class', async () => {
        const res = await setStatus('admin', STUDENT.A1, { status: 'GRADUATED', graduated_academic_year: YEAR });
        expect(res.status).toBe(200);
        const s = await student(STUDENT.A1);
        expect([s.status, s.class_id, s.graduated_from_class_id, s.graduated_academic_year]).toEqual(['GRADUATED', null, CLASS_AUG, YEAR]);
        expect(s.graduated_at).not.toBeNull();
    });

    it('refuses the same status, a departed student straight back to ENROLLED, and an unknown status', async () => {
        expect((await setStatus('admin', STUDENT.A1, { status: 'ENROLLED' })).status).toBe(400);
        await setStatus('admin', STUDENT.A1, { status: 'EXPELLED', reason: 'x' });
        const back = await setStatus('admin', STUDENT.A1, { status: 'ENROLLED' });
        expect(back.status).toBe(400);
        expect(back.body.message).toMatch(/Use POST \/students\/9001\/return/);
        expect((await setStatus('admin', STUDENT.A1, { status: 'SUSPENDED' })).status).toBe(400);
        expect((await student(STUDENT.A1)).status).toBe('EXPELLED');
    });
});

describe('bringing a student back', () => {
    it('undo left restores ENROLLED and closes the departure flag', async () => {
        await setStatus('admin', STUDENT.A1, { status: 'LEFT', reason: 'x' });
        const res = await ctx.as.dirClerk.patch(`/students/${STUDENT.A1}/undo-left`);
        expect(res.status).toBe(200);
        expect((await student(STUDENT.A1)).status).toBe('ENROLLED');
        expect((await openPeriod(STUDENT.A1)).change_type).toBe('REINSTATED');
        const flags = await ctx.prisma.student_flags.findMany({ where: { student_id: STUDENT.A1 } });
        expect(flags.every((f) => f.work_done)).toBe(true);

        expect((await ctx.as.dirClerk.patch(`/students/${STUDENT.A1}/undo-left`)).status).toBe(400);
    });

    it('unexpels an expelled student, and refuses one who isn\'t', async () => {
        expect((await ctx.as.dirClerk.patch(`/students/${STUDENT.A1}/unexpel`)).status).toBe(400);
        await setStatus('admin', STUDENT.A1, { status: 'EXPELLED', reason: 'x' });
        expect((await ctx.as.dirClerk.patch(`/students/${STUDENT.A1}/unexpel`)).status).toBe(200);
        expect((await student(STUDENT.A1)).status).toBe('ENROLLED');
    });

    it('reinstates a graduate into their old class', async () => {
        await setStatus('admin', STUDENT.A1, { status: 'GRADUATED', graduated_academic_year: YEAR });
        const res = await ctx.as.dirClerk.post(`/students/${STUDENT.A1}/return`).send({ mode: 'REINSTATED', reason: 'Repeating the year' });
        expect(res.status).toBe(201);
        const s = await student(STUDENT.A1);
        expect([s.status, s.class_id, s.graduated_at]).toEqual(['ENROLLED', CLASS_AUG, null]);
        expect((await openPeriod(STUDENT.A1)).change_type).toBe('REINSTATED');
    });

    it('readmits a student into a new class with a new GR, recording an admission', async () => {
        await setStatus('admin', STUDENT.A1, { status: 'LEFT', reason: 'x' });
        const res = await ctx.as.dirClerk.post(`/students/${STUDENT.A1}/return`).send({
            mode: 'READMITTED', class_id: CLASS_VII, section_id: SECTION, gr_number: '160', academic_year: YEAR, reason: 'Back after a year',
        });
        expect(res.status).toBe(201);
        const s = await student(STUDENT.A1);
        expect([s.status, s.class_id, s.gr_number, s.house_id]).toEqual(['ENROLLED', CLASS_VII, '160', HOUSE.RED]);
        expect((await openPeriod(STUDENT.A1)).change_type).toBe('READMITTED');
        const admissions = await ctx.prisma.student_admissions.findMany({ where: { student_id: STUDENT.A1 } });
        expect(admissions).toEqual([expect.objectContaining({ is_readmission: true })]);
    });

    it('readmission needs a house and a valid GR, and only departed students return', async () => {
        await setStatus('admin', STUDENT.A2, { status: 'LEFT', reason: 'x' });
        const noHouse = await ctx.as.admin.post(`/students/${STUDENT.A2}/return`).send({ mode: 'READMITTED', gr_number: '170' });
        expect(noHouse.status).toBe(400);
        expect(noHouse.body.message).toMatch(/A house is required/);

        const badGr = await ctx.as.admin.post(`/students/${STUDENT.A2}/return`).send({ mode: 'READMITTED', gr_number: 'GEJ-1', house_id: HOUSE.BLUE });
        expect(badGr.status).toBe(400);

        expect((await ctx.as.admin.post(`/students/${STUDENT.A1}/return`).send({ mode: 'REINSTATED' })).status).toBe(400);
        expect((await ctx.as.admin.post(`/students/${STUDENT.A2}/return`).send({ mode: 'BACK' })).status).toBe(400);
        expect((await student(STUDENT.A2)).status).toBe('LEFT');
    });
});

describe('permanent deletion (DELETE /staff-editing/students/:id/hard-delete)', () => {
    it('needs a reason, then deletes the student and their records, keeping an audit row', async () => {
        await ctx.prisma.student_activities.create({ data: { student_id: STUDENT.A1, activity_name: 'Chess' } });
        expect((await ctx.as.admin.delete(`/staff-editing/students/${STUDENT.A1}/hard-delete`).send({})).status).toBe(400);

        const res = await ctx.as.admin.delete(`/staff-editing/students/${STUDENT.A1}/hard-delete`).send({ reason: 'Duplicate registration' });
        expect(res.status).toBe(200);
        expect(await ctx.prisma.students.findUnique({ where: { cc: STUDENT.A1 } })).toBeNull();
        expect(await ctx.prisma.student_activities.count()).toBe(0);
        // The sibling's guardians are untouched.
        expect(await ctx.prisma.student_guardians.count({ where: { student_id: STUDENT.A2 } })).toBe(2);
        const [audit] = await ctx.prisma.audit_logs.findMany({ where: { entity_type: 'STUDENT', action: 'DELETED' } });
        expect(audit.note).toMatch(/Reason: Duplicate registration/);
    });

    it('refuses while the student has family credit standing', async () => {
        const deposit = await ctx.prisma.deposits.create({ data: { student_id: STUDENT.A1, total_amount: 5000, excess_amount: 1000 } });
        await ctx.prisma.family_credit_ledger.create({
            data: { family_id: FAMILY, student_id: STUDENT.A1, deposit_id: deposit.id, amount: 1000, kind: 'EXCESS_DEPOSIT' },
        });
        const res = await ctx.as.admin.delete(`/staff-editing/students/${STUDENT.A1}/hard-delete`).send({ reason: 'Duplicate registration' });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/family credit entries/);
        expect(await ctx.prisma.students.findUnique({ where: { cc: STUDENT.A1 } })).not.toBeNull();
    });
});

describe('promotion', () => {
    it('a dry run reports the outcome and changes nothing', async () => {
        const res = await ctx.as.dirClerk.post('/students/promotion/single').send({
            student_id: STUDENT.A1, from: { class_id: CLASS_AUG }, to: { class_id: CLASS_VII }, target_academic_year: '2027-2028', dry_run: true,
        });
        expect(res.status).toBe(201);
        expect(res.body.data.outcome).toMatchObject({ status: 'promoted', dry_run: true, to_class_id: CLASS_VII });
        expect((await student(STUDENT.A1)).class_id).toBe(CLASS_AUG);
    });

    it('promotes one student, keeping the section and recording a PROMOTED period', async () => {
        const res = await ctx.as.dirClerk.post('/students/promotion/single').send({
            student_id: STUDENT.A1, from: { class_id: CLASS_AUG }, to: { class_id: CLASS_VII }, target_academic_year: '2027-2028',
        });
        expect(res.status).toBe(201);
        expect(res.body.data.summary.total_promoted).toBe(1);
        const s = await student(STUDENT.A1);
        expect([s.class_id, s.section_id, s.academic_year]).toEqual([CLASS_VII, SECTION, '2027-2028']);
        expect((await openPeriod(STUDENT.A1)).change_type).toBe('PROMOTED');
    });

    it('promotes a whole class at one campus', async () => {
        const res = await ctx.as.admin.post('/students/promotion/bulk').send({
            from: { class_id: CLASS_AUG }, to: { class_id: CLASS_VII }, campus_id: CAMPUS_A, target_academic_year: '2027-2028',
        });
        expect(res.status).toBe(201);
        expect(res.body.data.summary).toMatchObject({ total_promoted: 2, total_failed: 0, mode: 'promotion' });
        expect((await student(STUDENT.A1)).class_id).toBe(CLASS_VII);
        expect((await student(STUDENT.A2)).class_id).toBe(CLASS_VII);
        expect((await student(STUDENT.B1)).class_id).toBe(CLASS_AUG);
        const audit = await waitForAudit(() => ctx.prisma.audit_logs.findMany({ where: { action: 'PROMOTED' } }));
        expect(audit.length).toBeGreaterThan(0);
    });

    it('graduates and marks students left in bulk, skipping those already gone', async () => {
        const grad = await ctx.as.admin.post('/students/promotion/bulk').send({ student_ids: [STUDENT.A1], graduate: true, graduated_academic_year: YEAR });
        expect(grad.body.data.summary).toMatchObject({ total_graduated: 1, mode: 'graduation' });
        expect((await student(STUDENT.A1)).status).toBe('GRADUATED');

        await setStatus('admin', STUDENT.A2, { status: 'LEFT', reason: 'x' });
        const left = await ctx.as.admin.post('/students/promotion/bulk').send({ student_ids: [STUDENT.A2, STUDENT.A_APR], left: true });
        expect(left.body.data.summary).toMatchObject({ total_left: 1, total_skipped: 1 });
        const skipped = left.body.data.results.find((r: any) => r.student_id === STUDENT.A2);
        expect(skipped).toMatchObject({ status: 'skipped', reason_code: 'ALREADY_LEFT' });
        expect((await student(STUDENT.A_APR)).status).toBe('LEFT');
    });

    it('fails a student whose target class isn\'t offered at their campus', async () => {
        await ctx.prisma.campus_classes.updateMany({ where: { class_id: CLASS_VII }, data: { is_active: false } });
        const res = await ctx.as.admin.post('/students/promotion/bulk').send({
            student_ids: [STUDENT.A1], from: { class_id: CLASS_AUG }, to: { class_id: CLASS_VII },
        });
        expect(res.body.data.results[0]).toMatchObject({ status: 'failed', reason_code: 'TARGET_CLASS_INACTIVE_FOR_CAMPUS' });
        expect((await student(STUDENT.A1)).class_id).toBe(CLASS_AUG);
    });

    it('rejects requests with no target, more than one target, or the same class', async () => {
        const bodies = [
            { student_ids: [STUDENT.A1] },
            { student_ids: [STUDENT.A1], graduate: true, left: true },
            { student_ids: [STUDENT.A1], from: { class_id: CLASS_AUG }, to: { class_id: CLASS_AUG } },
        ];
        for (const body of bodies) {
            expect((await ctx.as.admin.post('/students/promotion/bulk').send(body)).status).toBe(400);
        }
    });

    it('a campus-scoped user can\'t promote into another campus', async () => {
        const res = await ctx.as.dirClerk.post('/students/promotion/bulk').send({
            student_ids: [STUDENT.A1], from: { class_id: CLASS_AUG }, to: { class_id: CLASS_VII }, to_campus_id: CAMPUS_B,
        });
        expect(res.status).toBe(403);
        expect((await student(STUDENT.A1)).campus_id).toBe(CAMPUS_A);
    });

    it('suggests A-Level GR numbers for students moving up', async () => {
        const res = await ctx.as.dirClerk.post('/students/gr-numbers/suggest-for-promotion').send({ student_ccs: [STUDENT.A1, STUDENT.A2], a_level: true });
        expect(res.status).toBe(201);
        const grs = Object.values(res.body.data.assignments) as string[];
        expect(grs).toHaveLength(2);
        expect(grs.every((g) => /^A-\d+$/.test(g))).toBe(true);
        expect(new Set(grs).size).toBe(2);

        expect((await ctx.as.dirClerk.post('/students/gr-numbers/suggest-for-promotion').send({ student_ccs: [STUDENT.B1] })).status).toBe(404);
    });
});

describe('who may do it', () => {
    it('status changes need status.change; promotion needs promote', async () => {
        const attempts: [string, () => Promise<{ status: number }>][] = [
            ['status', () => setStatus('dirNoStatus', STUDENT.A1, { status: 'LEFT' })],
            ['undo-left', () => ctx.as.dirNoStatus.patch(`/students/${STUDENT.A1}/undo-left`)],
            ['unexpel', () => ctx.as.dirNoStatus.patch(`/students/${STUDENT.A1}/unexpel`)],
            ['return', () => ctx.as.dirNoStatus.post(`/students/${STUDENT.A1}/return`).send({ mode: 'REINSTATED' })],
            ['hard-delete', () => ctx.as.dirNoStatus.delete(`/staff-editing/students/${STUDENT.A1}/hard-delete`).send({ reason: 'xxxx' })],
            ['promote (viewer)', () => ctx.as.dirViewer.post('/students/promotion/single').send({ student_id: STUDENT.A1, graduate: true })],
        ];
        for (const [what, attempt] of attempts) {
            const res = await attempt();
            expect({ what, status: res.status }).toEqual({ what, status: 403 });
        }
        expect((await student(STUDENT.A1)).status).toBe('ENROLLED');
    });

    it('a campus-scoped user gets 404 for a student at another campus', async () => {
        expect((await setStatus('dirClerk', STUDENT.B1, { status: 'LEFT' })).status).toBe(404);
        expect((await ctx.as.dirClerk.delete(`/staff-editing/students/${STUDENT.B1}/hard-delete`).send({ reason: 'xxxx' })).status).toBe(404);
        expect((await student(STUDENT.B1)).status).toBe('ENROLLED');
    });
});
