/**
 * Student Directory: the Guardians tab, and the Admissions / Academic tabs'
 * records (admissions, activities, languages, previous schools, A-Level
 * details).
 */
import { STUDENT, YEAR } from '../helpers/fixtures';
import { FATHER_CNIC, waitForAudit } from './directory-fixtures';
import { directorySuite } from './suite';

const ctx = directorySuite();

const links = (cc: number) =>
    ctx.prisma.student_guardians.findMany({ where: { student_id: cc }, orderBy: { guardian_id: 'asc' } });

describe('guardians', () => {
    it('adds a new guardian to a student', async () => {
        const res = await ctx.as.dirClerk.post(`/staff-editing/students/${STUDENT.A_APR}/guardians`).send({
            full_name: 'Test Uncle', relationship: 'GUARDIAN', primary_phone: '03002223333', is_emergency_contact: true,
        });
        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({ full_name: 'TEST UNCLE', relationship: 'GUARDIAN', is_emergency_contact: true });
        expect((await links(STUDENT.A_APR)).map((l) => l.relationship)).toEqual(['GUARDIAN']);

        const audit = await waitForAudit(() => ctx.prisma.audit_logs.findMany({ where: { entity_type: 'GUARDIAN', action: 'CREATED' } }));
        expect(audit).toHaveLength(1);
    });

    it('adding a guardian whose CNIC is already registered links that guardian instead of duplicating it', async () => {
        const before = await ctx.prisma.guardians.count();
        const res = await ctx.as.dirClerk.post(`/staff-editing/students/${STUDENT.A_APR}/guardians`).send({
            full_name: 'TEST FATHER', relationship: 'FATHER', cnic: FATHER_CNIC,
        });
        expect(res.status).toBe(201);
        expect(await ctx.prisma.guardians.count()).toBe(before);
        expect((await links(STUDENT.A_APR)).map((l) => l.guardian_id)).toEqual([ctx.ids.fatherId]);
    });

    it('links an existing guardian, edits the relationship, and unlinks', async () => {
        const linked = await ctx.as.dirClerk.post(`/staff-editing/students/${STUDENT.A_APR}/guardians/link-existing`).send({
            guardian_id: ctx.ids.motherId, relationship: 'MOTHER',
        });
        expect(linked.status).toBe(201);

        const edited = await ctx.as.dirClerk.patch(`/staff-editing/students/${STUDENT.A_APR}/guardians/${ctx.ids.motherId}`).send({
            is_primary_contact: true, occupation: 'Doctor',
        });
        expect(edited.status).toBe(200);
        const [link] = await links(STUDENT.A_APR);
        expect(link.is_primary_contact).toBe(true);
        expect((await ctx.prisma.guardians.findUniqueOrThrow({ where: { id: ctx.ids.motherId } })).occupation).toBe('Doctor');

        expect((await ctx.as.dirClerk.delete(`/staff-editing/students/${STUDENT.A_APR}/guardians/${ctx.ids.motherId}`)).status).toBe(200);
        expect(await links(STUDENT.A_APR)).toHaveLength(0);
        // Unlinking keeps the guardian: the siblings still have her.
        expect((await links(STUDENT.A1)).map((l) => l.guardian_id)).toContain(ctx.ids.motherId);

        expect((await ctx.as.dirClerk.delete(`/staff-editing/students/${STUDENT.A_APR}/guardians/${ctx.ids.motherId}`)).status).toBe(404);
    });

    it('edits a guardian, and refuses a CNIC another guardian holds', async () => {
        const ok = await ctx.as.dirClerk.patch(`/staff-editing/guardians/${ctx.ids.motherId}`).send({ occupation: 'Engineer', primary_phone: '03004445555' });
        expect(ok.status).toBe(200);
        expect(ok.body.data).toMatchObject({ occupation: 'Engineer', primary_phone: '03004445555' });

        const clash = await ctx.as.dirClerk.patch(`/staff-editing/guardians/${ctx.ids.motherId}`).send({ cnic: FATHER_CNIC });
        expect(clash.status).toBe(409);
        expect(clash.body.message).toMatch(/already registered to guardian/);
    });

    it('deletes a guardian only once no student is linked to them', async () => {
        const stillLinked = await ctx.as.admin.delete(`/staff-editing/guardians/${ctx.ids.motherId}`);
        expect(stillLinked.status).toBe(400);
        expect(stillLinked.body.message).toMatch(/still linked to 2 student/);

        await ctx.prisma.student_guardians.deleteMany({ where: { guardian_id: ctx.ids.motherId } });
        const res = await ctx.as.admin.delete(`/staff-editing/guardians/${ctx.ids.motherId}`);
        expect(res.status).toBe(200);
        const mother = await ctx.prisma.guardians.findUniqueOrThrow({ where: { id: ctx.ids.motherId } });
        expect(mother.deleted_at).not.toBeNull();
        expect(mother.cnic).toBeNull();
        expect((await ctx.as.admin.get(`/staff-editing/guardians/${ctx.ids.motherId}`)).status).toBe(404);
    });

    it('opens a guardian, and looks one up by CNIC', async () => {
        const one = await ctx.as.dirClerk.get(`/staff-editing/guardians/${ctx.ids.fatherId}`);
        expect(one.status).toBe(200);
        expect(one.body.data).toMatchObject({ full_name: 'TEST FATHER', families: [expect.objectContaining({ household_name: 'TEST HOUSEHOLD' })] });

        const byNic = await ctx.as.dirClerk.get(`/staff-editing/guardians/by-nic/${FATHER_CNIC}`);
        expect(byNic.body.data.id).toBe(ctx.ids.fatherId);
        expect((await ctx.as.dirClerk.get('/staff-editing/guardians/by-nic/00000-0000000-0')).body.data).toBeNull();
    });

    it('validates the body, needs guardians.edit, and the student in scope', async () => {
        expect((await ctx.as.dirClerk.post(`/staff-editing/students/${STUDENT.A1}/guardians`).send({ full_name: 'No Relationship' })).status).toBe(400);
        expect((await ctx.as.dirViewer.post(`/staff-editing/students/${STUDENT.A1}/guardians`).send({ full_name: 'X', relationship: 'UNCLE' })).status).toBe(403);
        expect((await ctx.as.dirClerk.post(`/staff-editing/students/${STUDENT.B1}/guardians`).send({ full_name: 'X', relationship: 'UNCLE' })).status).toBe(404);
        expect((await ctx.as.dirViewer.patch(`/staff-editing/guardians/${ctx.ids.fatherId}`).send({ occupation: 'x' })).status).toBe(403);
        expect(await ctx.prisma.guardians.count()).toBe(2);
    });

    it('TAFSD-564: adding a guardian with the CNIC of a parent outside scope is refused, not linked', async () => {
        const other = await ctx.prisma.guardians.create({
            data: { full_name: 'OTHER CAMPUS PARENT', cnic: '42101-9999999-9', student_guardians: { create: { student_id: STUDENT.B1, relationship: 'FATHER' } } },
        });
        const res = await ctx.as.dirClerk.post(`/staff-editing/students/${STUDENT.A_APR}/guardians`).send({
            full_name: 'SOMEONE', relationship: 'FATHER', cnic: '42101-9999999-9',
        });
        expect(res.status).toBe(409);
        expect(await ctx.prisma.student_guardians.count({ where: { guardian_id: other.id } })).toBe(1);

        // An unrestricted admin can still link them.
        expect((await ctx.as.admin.post(`/staff-editing/students/${STUDENT.A_APR}/guardians`).send({
            full_name: 'SOMEONE', relationship: 'FATHER', cnic: '42101-9999999-9',
        })).status).toBe(201);
        expect((await links(STUDENT.A_APR)).map((l) => l.guardian_id)).toEqual([other.id]);
    });

    it('TAFSD-564: a deleted guardian can\'t be linked', async () => {
        const gone = await ctx.prisma.guardians.create({ data: { full_name: 'GONE', deleted_at: new Date() } });
        const res = await ctx.as.admin.post(`/staff-editing/students/${STUDENT.A_APR}/guardians/link-existing`).send({ guardian_id: gone.id, relationship: 'FATHER' });
        expect(res.status).toBe(404);
        expect(await links(STUDENT.A_APR)).toEqual([]);
    });
});

describe('admissions and academic records', () => {
    it('saves and deletes an admission record', async () => {
        const res = await ctx.as.dirClerk.post(`/staff-editing/students/${STUDENT.A1}/admissions`).send({
            academic_system: 'Matric', requested_grade: 'VI', academic_year: YEAR, discipline: 'Science',
        });
        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({ student_id: STUDENT.A1, academic_system: 'Matric', discipline: 'Science' });

        const record = await ctx.as.dirClerk.get(`/staff-editing/students/${STUDENT.A1}`);
        expect(record.body.data.admissions.map((a: any) => a.id)).toEqual([res.body.data.id]);

        expect((await ctx.as.dirClerk.delete(`/staff-editing/admissions/${res.body.data.id}`)).status).toBe(200);
        expect(await ctx.prisma.student_admissions.count({ where: { student_id: STUDENT.A1 } })).toBe(0);
    });

    it('saves, updates and deletes activities, languages and previous schools', async () => {
        const cases: [string, object, object, string][] = [
            ['activities', { activity_name: 'Debating', grade: 'V' }, { activity_name: 'Debating Club' }, 'student_activities'],
            ['languages', { language_name: 'Urdu', can_speak: true }, { can_read: true }, 'student_languages'],
            ['schools', { school_name: 'Old School', location: 'Karachi' }, { reason_for_leaving: 'Moved' }, 'student_previous_schools'],
        ];
        for (const [route, create, update, table] of cases) {
            const made = await ctx.as.dirClerk.post(`/staff-editing/students/${STUDENT.A1}/${route}`).send(create);
            expect({ route, status: made.status }).toEqual({ route, status: 201 });
            expect(made.body.data).toMatchObject(create);

            const updated = await ctx.as.dirClerk.post(`/staff-editing/students/${STUDENT.A1}/${route}`).send({ id: made.body.data.id, ...create, ...update });
            expect(updated.body.data).toMatchObject({ id: made.body.data.id, ...update });

            const count = () => (ctx.prisma as any)[table].count({ where: { student_id: STUDENT.A1 } });
            expect(await count()).toBe(1);
            expect((await ctx.as.dirClerk.delete(`/staff-editing/${route}/${made.body.data.id}`)).status).toBe(200);
            expect(await count()).toBe(0);
        }
    });

    it('saves A-Level details and shows them on the record', async () => {
        const res = await ctx.as.dirClerk.post(`/staff-editing/students/${STUDENT.A1}/alevel-details`).send({
            preferred_subjects_group_a: ['Physics', 'Chemistry'], olevel_result_counts: { A: 4, B: 3 },
        });
        expect(res.status).toBe(201);
        const record = await ctx.as.dirClerk.get(`/staff-editing/students/${STUDENT.A1}`);
        expect(record.body.data.alevel_details).toMatchObject({ preferred_subjects_group_a: ['Physics', 'Chemistry'] });
    });

    it('needs admissions.edit / academic.edit, and the student in scope', async () => {
        expect((await ctx.as.dirViewer.post(`/staff-editing/students/${STUDENT.A1}/admissions`).send({ academic_system: 'Matric' })).status).toBe(403);
        expect((await ctx.as.dirViewer.post(`/staff-editing/students/${STUDENT.A1}/activities`).send({ activity_name: 'x' })).status).toBe(403);
        expect((await ctx.as.dirClerk.post(`/staff-editing/students/${STUDENT.B1}/languages`).send({ language_name: 'x' })).status).toBe(404);
        const other = await ctx.prisma.student_activities.create({ data: { student_id: STUDENT.B1, activity_name: 'Chess' } });
        expect((await ctx.as.dirClerk.delete(`/staff-editing/activities/${other.id}`)).status).toBe(404);
        expect(await ctx.prisma.student_activities.count()).toBe(1);
    });

    it('TAFSD-560: an id that isn\'t this student\'s row is 404, and that row stays where it was', async () => {
        const theirs = {
            admissions: await ctx.prisma.student_admissions.create({ data: { student_id: STUDENT.B1, academic_system: 'Matric', requested_grade: 'VI' } }),
            languages: await ctx.prisma.student_languages.create({ data: { student_id: STUDENT.B1, language_name: 'Sindhi' } }),
            schools: await ctx.prisma.student_previous_schools.create({ data: { student_id: STUDENT.B1, school_name: 'Their School' } }),
        };
        // A sibling row of the same student in scope (A2) is just as off limits.
        const sibling = await ctx.prisma.student_activities.create({ data: { student_id: STUDENT.A2, activity_name: 'Chess' } });
        const sends: [string, number, object][] = [
            ['admissions', theirs.admissions.id, { academic_system: 'O-Level' }],
            ['languages', theirs.languages.id, { language_name: 'Taken' }],
            ['schools', theirs.schools.id, { school_name: 'Taken' }],
            ['activities', sibling.id, { activity_name: 'Taken' }],
        ];
        for (const [route, id, body] of sends) {
            const res = await ctx.as.dirClerk.post(`/staff-editing/students/${STUDENT.A1}/${route}`).send({ id, ...body });
            expect({ route, status: res.status }).toEqual({ route, status: 404 });
        }
        expect(await ctx.prisma.student_admissions.findUniqueOrThrow({ where: { id: theirs.admissions.id } })).toMatchObject({ student_id: STUDENT.B1, academic_system: 'Matric' });
        expect(await ctx.prisma.student_languages.findUniqueOrThrow({ where: { id: theirs.languages.id } })).toMatchObject({ student_id: STUDENT.B1, language_name: 'Sindhi' });
        expect(await ctx.prisma.student_previous_schools.findUniqueOrThrow({ where: { id: theirs.schools.id } })).toMatchObject({ student_id: STUDENT.B1, school_name: 'Their School' });
        expect(await ctx.prisma.student_activities.findUniqueOrThrow({ where: { id: sibling.id } })).toMatchObject({ student_id: STUDENT.A2, activity_name: 'Chess' });
    });

    it('TAFSD-560: only the form\'s own fields are accepted', async () => {
        const res = await ctx.as.dirClerk.post(`/staff-editing/students/${STUDENT.A1}/activities`).send({ activity_name: 'Debating', student_id: STUDENT.B1 });
        expect(res.status).toBe(400);
        expect(await ctx.prisma.student_activities.count()).toBe(0);
    });
});
