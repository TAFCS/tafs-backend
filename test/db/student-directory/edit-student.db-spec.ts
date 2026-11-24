/**
 * Student Directory: editing a student. The Identity / Class & Grade tabs
 * (PATCH /staff-editing/students/:id), special categories, parents' names,
 * the family address, flags, the uniform-photo follow-up, photo uploads, and
 * moving a student (PATCH /students/:id/assignment).
 */
import { CAMPUS_B, CLASS_AUG, SECTION, STUDENT } from '../helpers/fixtures';
import { CLASS_VII, FATHER_CNIC, GR, HOUSE, waitForAudit } from './directory-fixtures';
import { directorySuite } from './suite';

const ctx = directorySuite();

const student = (cc: number) => ctx.prisma.students.findUniqueOrThrow({ where: { cc } });
const patch = (who: keyof typeof ctx.as, cc: number, body: object) => ctx.as[who].patch(`/staff-editing/students/${cc}`).send(body);

describe('identity edits (PATCH /staff-editing/students/:id)', () => {
    it('saves identity fields and writes an audit trail', async () => {
        const res = await patch('dirClerk', STUDENT.A1, { full_name: 'Test Student Renamed', city: 'Karachi', dob: '2015-03-04' });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ cc: STUDENT.A1, full_name: 'Test Student Renamed', city: 'Karachi' });

        const s = await student(STUDENT.A1);
        expect([s.full_name, s.city, s.dob?.toISOString().slice(0, 10)]).toEqual(['Test Student Renamed', 'Karachi', '2015-03-04']);

        const audit = await waitForAudit(() => ctx.prisma.audit_logs.findMany({ where: { student_id: STUDENT.A1, entity_type: 'STUDENT' } }));
        expect(audit.length).toBeGreaterThan(0);
        expect(audit.some((a) => a.changed_by === 'dbsuite.dirclerk')).toBe(true);
    });

    it('changes the GR, and refuses one another student at the campus already has', async () => {
        expect((await patch('admin', STUDENT.A1, { gr_number: '150' })).status).toBe(200);
        expect((await student(STUDENT.A1)).gr_number).toBe('150');

        const clash = await patch('admin', STUDENT.A1, { gr_number: GR.A2 });
        expect(clash.status).toBe(400);
        expect(clash.body.message).toMatch(/already assigned to another student in this campus/);
        expect((await student(STUDENT.A1)).gr_number).toBe('150');
    });

    it('gives and removes a special category, which needs a reason and an end date', async () => {
        const bare = await patch('admin', STUDENT.A1, { categories: [{ code: 'FEE_ENDOWMENT', on: true }] });
        expect(bare.status).toBe(400);
        expect(bare.body.message).toMatch(/require a reason and an until date/);

        const ok = await patch('admin', STUDENT.A1, { categories: [{ code: 'FEE_ENDOWMENT', on: true, reason: 'board approval', until: '2027-07-31' }] });
        expect(ok.status).toBe(200);
        expect(ok.body.data.categories).toEqual([expect.objectContaining({ key: 'FEE_ENDOWMENT', reason: 'board approval', until: '2027-07-31' })]);
        expect(await ctx.prisma.student_category_assignments.count({ where: { student_id: STUDENT.A1 } })).toBe(1);

        expect((await patch('admin', STUDENT.A1, { categories: [{ code: 'FEE_ENDOWMENT', on: false }] })).status).toBe(200);
        expect(await ctx.prisma.student_category_assignments.count({ where: { student_id: STUDENT.A1 } })).toBe(0);

        expect((await patch('admin', STUDENT.A1, { categories: [{ code: 'NOT_A_CATEGORY', on: true }] })).status).toBe(400);
    });

    it('edits the father\'s name on the shared guardian, so the sibling sees it too', async () => {
        const res = await patch('admin', STUDENT.A1, { father_name: 'TEST FATHER RENAMED' });
        expect(res.status).toBe(200);
        const father = await ctx.prisma.guardians.findUniqueOrThrow({ where: { cnic: FATHER_CNIC } });
        expect(father.full_name).toBe('TEST FATHER RENAMED');
        const sibling = await ctx.as.admin.get(`/staff-editing/students/${STUDENT.A2}/guardians`);
        expect(sibling.body.data.find((g: any) => g.relationship === 'FATHER').full_name).toBe('TEST FATHER RENAMED');
    });

    it('a second photo clears the uniform-photo flag and is kept in the photo history', async () => {
        await ctx.prisma.students.update({ where: { cc: STUDENT.A1 }, data: { photograph_url: 'http://mock-storage/admission.jpg' } });
        expect((await student(STUDENT.A1)).uniform_photo_pending).toBe(true);

        expect((await patch('admin', STUDENT.A1, { photograph_url: 'http://mock-storage/uniform.jpg' })).status).toBe(200);
        const s = await student(STUDENT.A1);
        expect([s.photograph_url, s.uniform_photo_pending]).toEqual(['http://mock-storage/uniform.jpg', false]);
        const history = await ctx.prisma.student_photo_history.findMany({ where: { student_id: STUDENT.A1 } });
        expect(history.map((h) => h.url)).toEqual(['http://mock-storage/uniform.jpg']);
    });

    it('refuses fields that are not editable here, and unknown fields', async () => {
        for (const body of [{ uniform_photo_pending: false }, { family_id: 1 }, { nickname: 'x' }, { email: 42 }]) {
            expect((await patch('admin', STUDENT.A1, body)).status).toBe(400);
        }
    });

    it('404s for a student outside the editor\'s campus, and changes nothing', async () => {
        expect((await patch('dirClerk', STUDENT.B1, { full_name: 'Hijacked' })).status).toBe(404);
        expect((await student(STUDENT.B1)).full_name).toBe('Test Student Campus B');
    });

    it('needs identity.edit', async () => {
        expect((await patch('dirViewer', STUDENT.A1, { full_name: 'x' })).status).toBe(403);
        expect((await student(STUDENT.A1)).full_name).toBe('Test Student One');
    });

    it('TAFSD-561: moving a student through this form needs "Move a student"; Class & Grade moves still work', async () => {
        expect((await patch('dirNoMove', STUDENT.A1, { class_id: CLASS_VII, section_id: SECTION })).status).toBe(403);
        expect((await student(STUDENT.A1)).class_id).toBe(CLASS_AUG);

        expect((await patch('dirClerk', STUDENT.A1, { class_id: CLASS_VII, section_id: SECTION })).status).toBe(200);
        expect((await student(STUDENT.A1)).class_id).toBe(CLASS_VII);
    });

    it('TAFSD-561: values sent back unchanged need no extra permission', async () => {
        const s = await student(STUDENT.A1);
        const res = await patch('dirNoMove', STUDENT.A1, {
            full_name: 'Renamed Only',
            campus_id: s.campus_id!, class_id: s.class_id!, section_id: s.section_id!,
        });
        expect(res.status).toBe(200);
        expect((await patch('dirNoStatus', STUDENT.A1, { status: s.status, city: 'Karachi' })).status).toBe(200);
        expect((await student(STUDENT.A1)).full_name).toBe('Renamed Only');
    });
});

describe('family address (PATCH /staff-editing/students/:id/family-address)', () => {
    it('updates this student\'s guardians\' address', async () => {
        const res = await ctx.as.dirClerk.patch(`/staff-editing/students/${STUDENT.A1}/family-address`).send({
            house_appt_name: 'House 12', area_block: 'Block 5', city: 'Karachi',
        });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ success: true, count: 2, target: 'individual' });
        const guardians = await ctx.prisma.guardians.findMany({ where: { deleted_at: null } });
        expect(guardians.every((g) => g.house_appt_name === 'House 12' && g.city === 'Karachi')).toBe(true);
    });

    it('needs identity.edit and the student in scope', async () => {
        expect((await ctx.as.dirViewer.patch(`/staff-editing/students/${STUDENT.A1}/family-address`).send({ city: 'x' })).status).toBe(403);
        expect((await ctx.as.dirClerk.patch(`/staff-editing/students/${STUDENT.B1}/family-address`).send({ city: 'x' })).status).toBe(404);
    });

    it('TAFSD-562: a household sync leaves the guardians of a sibling outside the editor\'s campus alone', async () => {
        // B1 (campus B) joins A1's family, with a parent linked only to B1.
        await ctx.prisma.students.update({ where: { cc: STUDENT.B1 }, data: { family_id: 1 } });
        const theirs = await ctx.prisma.guardians.create({
            data: { full_name: 'CAMPUS B PARENT', city: 'Lahore', student_guardians: { create: { student_id: STUDENT.B1, relationship: 'FATHER' } } },
        });
        const res = await ctx.as.dirClerk.patch(`/staff-editing/students/${STUDENT.A1}/family-address`).send({ city: 'Karachi', bulk_sync: true });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ success: true, count: 2, target: 'household' });
        expect((await ctx.prisma.guardians.findUniqueOrThrow({ where: { id: theirs.id } })).city).toBe('Lahore');

        // An unrestricted admin's sync reaches the whole household.
        expect((await ctx.as.admin.patch(`/staff-editing/students/${STUDENT.A1}/family-address`).send({ city: 'Hyderabad', bulk_sync: true })).body.data.count).toBe(3);
        expect((await ctx.prisma.guardians.findUniqueOrThrow({ where: { id: theirs.id } })).city).toBe('Hyderabad');
    });

    it('TAFSD-562: bulk_sync must be a real true/false, not the text "false"', async () => {
        const res = await ctx.as.dirClerk.patch(`/staff-editing/students/${STUDENT.A1}/family-address`).send({ city: 'Quetta', bulk_sync: 'false' });
        expect(res.status).toBe(400);
        expect((await ctx.prisma.guardians.findMany({ where: { city: 'Quetta' } })).length).toBe(0);
    });
});

describe('flags (/student-flags)', () => {
    it('adds a flag with a reminder, lists it, marks it done and removes it', async () => {
        const added = await ctx.as.dirClerk.post(`/student-flags/${STUDENT.A1}`).send({ flag: 'fast_track_review', reminder_date: '2026-01-01' });
        expect(added.status).toBe(201);
        expect(added.body.data).toMatchObject({ student_id: STUDENT.A1, flag: 'fast_track_review', work_done: false });

        const listed = await ctx.as.dirClerk.get(`/student-flags/${STUDENT.A1}`);
        expect(listed.body.data.map((f: any) => f.flag)).toEqual(['fast_track_review']);

        // Its reminder date has passed, so it shows in the notification bell.
        const count = await ctx.as.dirClerk.get('/student-flags/all/notifications/count');
        expect(count.body.data.count).toBe(1);
        const notes = await ctx.as.dirClerk.get('/student-flags/all/notifications');
        expect(notes.body.data[0].message).toMatch(/Fast Track promotion due for Test Student One/);

        expect((await ctx.as.dirClerk.patch(`/student-flags/${STUDENT.A1}/fast_track_review/done`)).status).toBe(200);
        expect((await ctx.prisma.student_flags.findFirstOrThrow({ where: { student_id: STUDENT.A1 } })).work_done).toBe(true);

        const removed = await ctx.as.dirClerk.delete(`/student-flags/${STUDENT.A1}/fast_track_review`);
        expect(removed.body.data).toEqual({ count: 1 });
        expect(await ctx.prisma.student_flags.count({ where: { student_id: STUDENT.A1 } })).toBe(0);
    });

    it('needs an edit action, and the student in scope', async () => {
        expect((await ctx.as.dirViewer.post(`/student-flags/${STUDENT.A1}`).send({ flag: 'x' })).status).toBe(403);
        expect((await ctx.as.dirClerk.post(`/student-flags/${STUDENT.B1}`).send({ flag: 'x' })).status).toBe(404);
        expect(await ctx.prisma.student_flags.count()).toBe(0);
    });
});

describe('uniform photo follow-up (PATCH /uniform-photos/:cc)', () => {
    it('marks a student as already in uniform, and back', async () => {
        const res = await ctx.as.dirClerk.patch(`/uniform-photos/${STUDENT.A1}`).send({ pending: false });
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ cc: STUDENT.A1, uniform_photo_pending: false });
        expect((await student(STUDENT.A1)).uniform_photo_pending).toBe(false);

        const audit = await waitForAudit(() => ctx.prisma.audit_logs.findMany({ where: { student_id: STUDENT.A1, field: 'uniform_photo_pending' } }));
        expect(audit[0]).toMatchObject({ old_value: 'true', new_value: 'false' });

        expect((await ctx.as.dirClerk.patch(`/uniform-photos/${STUDENT.A1}`).send({ pending: true })).status).toBe(200);
        expect((await student(STUDENT.A1)).uniform_photo_pending).toBe(true);
    });

    it('validates the body and needs the uniform_photo action', async () => {
        expect((await ctx.as.dirClerk.patch(`/uniform-photos/${STUDENT.A1}`).send({ pending: 'no' })).status).toBe(400);
        expect((await ctx.as.dirViewer.patch(`/uniform-photos/${STUDENT.A1}`).send({ pending: false })).status).toBe(403);
        expect((await ctx.as.dirClerk.patch(`/uniform-photos/${STUDENT.B1}`).send({ pending: false })).status).toBe(404);
    });
});

describe('photos (/media)', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

    it('uploads a student photo (to mock storage), records it, and removes it', async () => {
        const first = await ctx.as.dirClerk.post(`/media/student/${STUDENT.A1}/photo/standard`).attach('file', jpeg, 'a.jpg');
        expect(first.status).toBe(201);
        expect(first.body.url).toMatch(/^http:\/\/mock-storage\/media\/students\/9001\/standard-/);
        expect((await student(STUDENT.A1)).photograph_url).toBe(first.body.url);
        // The first photo is the admission photo: the student is still flagged.
        expect((await student(STUDENT.A1)).uniform_photo_pending).toBe(true);

        const second = await ctx.as.dirClerk.post(`/media/student/${STUDENT.A1}/photo/standard`).attach('file', Buffer.from([0xff, 0xd8, 9, 9]), 'b.jpg');
        expect(second.status).toBe(201);
        expect((await student(STUDENT.A1)).uniform_photo_pending).toBe(false);
        expect(await ctx.prisma.student_photo_history.count({ where: { student_id: STUDENT.A1 } })).toBe(2);

        const removed = await ctx.as.dirClerk.delete(`/media/student/${STUDENT.A1}/photo/standard`);
        expect(removed.status).toBe(200);
        expect((await student(STUDENT.A1)).photograph_url).toBeNull();
    });

    it('uploads a guardian photo', async () => {
        const res = await ctx.as.dirClerk.post(`/media/guardian/${ctx.ids.fatherId}/photo`).attach('file', jpeg, 'f.jpg');
        expect(res.status).toBe(201);
        expect((await ctx.prisma.guardians.findUniqueOrThrow({ where: { id: ctx.ids.fatherId } })).photo_url).toBe(res.body.url);
    });

    it('refuses a wrong photo type, a missing file, a reader, and another campus', async () => {
        expect((await ctx.as.dirClerk.post(`/media/student/${STUDENT.A1}/photo/selfie`).attach('file', jpeg, 'a.jpg')).status).toBe(400);
        expect((await ctx.as.dirClerk.post(`/media/student/${STUDENT.A1}/photo/standard`)).status).toBe(400);
        expect((await ctx.as.dirViewer.post(`/media/student/${STUDENT.A1}/photo/standard`).attach('file', jpeg, 'a.jpg')).status).toBe(403);
        expect((await ctx.as.dirClerk.post(`/media/student/${STUDENT.B1}/photo/standard`).attach('file', jpeg, 'a.jpg')).status).toBe(404);
        expect((await student(STUDENT.A1)).photograph_url).toBeNull();
    });
});

describe('moving a student (PATCH /students/:id/assignment)', () => {
    it('changes house and records a HOUSE_CHANGED period', async () => {
        const res = await ctx.as.dirClerk.patch(`/students/${STUDENT.A1}/assignment`).send({ house_id: HOUSE.BLUE });
        expect(res.status).toBe(200);
        expect(res.body.data.houses.house_name).toBe('BLUE');
        const periods = await ctx.prisma.student_progression_periods.findMany({ where: { student_cc: STUDENT.A1, valid_to: null } });
        expect(periods.map((p) => [p.change_type, p.house_id])).toEqual([['HOUSE_CHANGED', HOUSE.BLUE]]);
    });

    it('moves a student to another class at the same campus', async () => {
        const res = await ctx.as.dirClerk.patch(`/students/${STUDENT.A1}/assignment`).send({ class_id: CLASS_VII, section_id: SECTION });
        expect(res.status).toBe(200);
        expect((await student(STUDENT.A1)).class_id).toBe(CLASS_VII);
        const [open] = await ctx.prisma.student_progression_periods.findMany({ where: { student_cc: STUDENT.A1, valid_to: null } });
        expect([open.change_type, open.class_id]).toEqual(['REASSIGNED', CLASS_VII]);
    });

    it('refuses a class that is not offered at the campus', async () => {
        await ctx.prisma.campus_classes.updateMany({ where: { class_id: CLASS_VII }, data: { is_active: false } });
        const res = await ctx.as.admin.patch(`/students/${STUDENT.A1}/assignment`).send({ class_id: CLASS_VII });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('CAMPUS_CLASS_INACTIVE');
        expect((await student(STUDENT.A1)).class_id).toBe(CLASS_AUG);
    });

    it('refuses a full section', async () => {
        await ctx.prisma.campus_sections.updateMany({ where: { class_id: CLASS_VII }, data: { student_capacity: 1 } });
        await ctx.prisma.students.update({ where: { cc: STUDENT.A2 }, data: { class_id: CLASS_VII } });
        const res = await ctx.as.admin.patch(`/students/${STUDENT.A1}/assignment`).send({ class_id: CLASS_VII });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('SECTION_FULL');
    });

    it('a campus-scoped user can\'t move a student to another campus, or move another campus\'s student', async () => {
        expect((await ctx.as.dirClerk.patch(`/students/${STUDENT.A1}/assignment`).send({ campus_id: CAMPUS_B })).status).toBe(403);
        expect((await ctx.as.dirClerk.patch(`/students/${STUDENT.B1}/assignment`).send({ house_id: HOUSE.BLUE })).status).toBe(404);
        expect((await student(STUDENT.A1)).campus_id).toBe(1);
    });
});
