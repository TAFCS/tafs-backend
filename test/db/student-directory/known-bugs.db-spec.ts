/**
 * Known Student Directory bugs, each pinned with `it.failing`.
 *
 * Every test states the CORRECT behaviour. `it.failing` passes while the code
 * still gets it wrong, so CI stays green today, and turns red the moment the
 * bug is fixed. When that happens: change `it.failing` to `it` in the same PR
 * as the fix, and close the ticket named in the test.
 */
import { CAMPUS_B, CLASS_AUG, STUDENT } from '../helpers/fixtures';
import { DIR_USERS, HOUSE, waitForAudit } from './directory-fixtures';
import { directorySuite } from './suite';

const ctx = directorySuite();

const student = (cc: number) => ctx.prisma.students.findUniqueOrThrow({ where: { cc } });

describe('known bugs', () => {
    it('TAFSD-560: saving an activity with another student\'s row id must not move that row to this student', async () => {
        const theirs = await ctx.prisma.student_activities.create({ data: { student_id: STUDENT.B1, activity_name: 'Chess' } });
        const res = await ctx.as.dirClerk.post(`/staff-editing/students/${STUDENT.A1}/activities`).send({ id: theirs.id, activity_name: 'Taken' });
        expect([400, 404]).toContain(res.status);
        expect(await ctx.prisma.student_activities.findUniqueOrThrow({ where: { id: theirs.id } })).toMatchObject({ student_id: STUDENT.B1, activity_name: 'Chess' });
    });

    it('TAFSD-561: changing status through the identity form needs status.change', async () => {
        const res = await ctx.as.dirNoStatus.patch(`/staff-editing/students/${STUDENT.A1}`).send({ status: 'LEFT' });
        expect(res.status).toBe(403);
        expect((await student(STUDENT.A1)).status).toBe('ENROLLED');
    });

    it('TAFSD-561: the identity form can\'t move a student to a campus outside the editor\'s scope', async () => {
        const res = await ctx.as.dirClerk.patch(`/staff-editing/students/${STUDENT.A1}`).send({ campus_id: CAMPUS_B });
        expect(res.status).toBe(403);
        expect((await student(STUDENT.A1)).campus_id).not.toBe(CAMPUS_B);
    });

    it('TAFSD-562: the family address form only accepts address fields', async () => {
        const res = await ctx.as.dirClerk.patch(`/staff-editing/students/${STUDENT.A1}/family-address`).send({ full_name: 'HIJACKED' });
        expect(res.status).toBe(400);
        const names = (await ctx.prisma.guardians.findMany()).map((g) => g.full_name).sort();
        expect(names).toEqual(['TEST FATHER', 'TEST MOTHER']);
    });

    it.failing('TAFSD-563: a Payment History tile holder can open a student\'s payment history', async () => {
        const res = await ctx.as.payHistoryOnly.get(`/students/${STUDENT.A1}/payment-history?academic_year=2026-2027`);
        expect(res.status).toBe(200);
    });

    it('TAFSD-564: looking a guardian up by CNIC doesn\'t reveal a guardian of a student outside scope', async () => {
        await ctx.prisma.guardians.create({
            data: { full_name: 'OTHER CAMPUS PARENT', cnic: '42101-9999999-9', student_guardians: { create: { student_id: STUDENT.B1, relationship: 'FATHER' } } },
        });
        const res = await ctx.as.dirClerk.get('/staff-editing/guardians/by-nic/42101-9999999-9');
        expect(res.status === 404 || res.body.data == null).toBe(true);
    });

    it('TAFSD-564: linking an existing guardian checks that guardian is in scope', async () => {
        const other = await ctx.prisma.guardians.create({
            data: { full_name: 'OTHER CAMPUS PARENT', cnic: '42101-9999999-9', student_guardians: { create: { student_id: STUDENT.B1, relationship: 'FATHER' } } },
        });
        const res = await ctx.as.dirClerk.post(`/staff-editing/students/${STUDENT.A1}/guardians/link-existing`).send({ guardian_id: other.id, relationship: 'FATHER' });
        expect(res.status).toBe(404);
        expect(await ctx.prisma.student_guardians.count({ where: { student_id: STUDENT.A1, guardian_id: other.id } })).toBe(0);
    });

    it.failing('TAFSD-565: a house move through Class & Grade shows in the house history', async () => {
        expect((await ctx.as.admin.patch(`/students/${STUDENT.A1}/assignment`).send({ house_id: HOUSE.BLUE })).status).toBe(200);
        await waitForAudit(() => ctx.prisma.audit_logs.findMany({ where: { student_id: STUDENT.A1 } }));
        const res = await ctx.as.admin.get(`/students/${STUDENT.A1}/house-history`);
        expect(res.body.data).toEqual([expect.objectContaining({ to_house: expect.objectContaining({ house_name: 'BLUE' }) })]);
    });

    it.failing('TAFSD-567: editing a phone number doesn\'t add a "reassigned" period to the academic history', async () => {
        await ctx.prisma.student_progression_periods.create({
            data: { student_cc: STUDENT.A1, campus_id: 1, class_id: CLASS_AUG, change_type: 'ENROLLED', valid_from: new Date('2026-08-01') },
        });
        expect((await ctx.as.admin.patch(`/staff-editing/students/${STUDENT.A1}`).send({ primary_phone: '03009998888' })).status).toBe(200);
        const periods = await ctx.prisma.student_progression_periods.findMany({ where: { student_cc: STUDENT.A1 } });
        expect(periods.map((p) => p.change_type)).toEqual(['ENROLLED']);
    });

    it.failing('TAFSD-568: adding a flag with no name is a 400, not a 500', async () => {
        const res = await ctx.as.dirClerk.post(`/student-flags/${STUDENT.A1}`).send({});
        expect(res.status).toBe(400);
    });

    it.failing('TAFSD-568: giving a student another student\'s CNIC is a 409, not a 500', async () => {
        await ctx.prisma.students.update({ where: { cc: STUDENT.A2 }, data: { cnic: '42101-5555555-5' } });
        const res = await ctx.as.admin.patch(`/staff-editing/students/${STUDENT.A1}`).send({ cnic: '42101-5555555-5' });
        expect([400, 409]).toContain(res.status);
    });

    it.failing('TAFSD-569: a non-numeric campus filter is a 400, not "every campus"', async () => {
        const res = await ctx.as.admin.get('/students?campus_id=abc');
        expect(res.status).toBe(400);
    });

    it.failing('TAFSD-570: logging a certificate without a document type is refused, not reported as success', async () => {
        const res = await ctx.as.dirClerk.post(`/enrollments/${STUDENT.A1}/log-certificate-generation`).send({ note: 'no type' });
        expect(res.status).toBe(400);
    });

    it('fixtures: the payment-history-only user exists (keeps the bug above honest)', async () => {
        expect(await ctx.prisma.users.count({ where: { id: DIR_USERS.payHistoryOnly.id } })).toBe(1);
    });
});
