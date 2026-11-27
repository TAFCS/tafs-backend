/**
 * TAFSD-605: permanently deleting a student who has extracurricular data still
 * works. The hard-delete (staff-editing) clears the EC rows itself, children
 * first, because the EC tables link to each other with NO ACTION and the
 * students cascade alone fails on ec_voucher_lines → ec_student_charges.
 */
import type { INestApplication } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import type { PrismaService } from '../../prisma/prisma.service';
import { bootApp, client, tokenFor } from './helpers/app';
import { STUDENT, USERS, YEAR, seedSchool } from './helpers/fixtures';
import { EC_USERS, seedEcUsers } from './helpers/ec-fixtures';
import { todayPktKey } from '../../src/modules/extracurricular/ec-dates.util';

let app: INestApplication;
let prisma: PrismaService;
let admin: ReturnType<typeof client>;
let manager: ReturnType<typeof client>;

beforeAll(async () => {
    let jwt: JwtService;
    ({ app, prisma, jwt } = await bootApp());
    await seedSchool(prisma);
    await seedEcUsers(prisma);
    admin = client(app, tokenFor(jwt, USERS.admin));
    manager = client(app, tokenFor(jwt, EC_USERS.ecManager));
});

afterAll(async () => {
    await app?.close();
});

it('removes the student and every EC row with them', async () => {
    const head = (await manager.post('/ec-fee-heads').send({ name: 'Chess Club', frequency: 'MONTHLY', months: [9, 10] })).body.data.id;
    await manager.post(`/ec-student-charges/student/${STUDENT.A2}/save`).send({
        academic_year: YEAR,
        cells: [
            { fee_head_id: head, target_month: 9, amount: 1000 },
            { fee_head_id: head, target_month: 10, amount: 1000 },
        ],
    });
    const charges = await prisma.ec_student_charges.findMany({ where: { student_id: STUDENT.A2 } });
    const today = todayPktKey();
    const v = await manager.post('/ec-vouchers').send({ student_id: STUDENT.A2, charge_ids: charges.map((c) => c.id), issue_date: today });
    expect(v.status).toBe(201);
    expect((await manager.post('/ec-deposits').send({ voucher_id: v.body.data.id, amount: 500, allocation: 'AUTO', payment_method: 'cash' })).status).toBe(201);
    // A reissue chain too: expire it, reissue the rest.
    await prisma.ec_vouchers.update({ where: { id: v.body.data.id }, data: { issue_date: new Date('2020-01-01T00:00:00Z'), expiry_date: new Date('2020-01-15T00:00:00Z') } });
    await prisma.ec_deposits.updateMany({ where: { voucher_id: v.body.data.id }, data: { deposit_date: new Date('2020-01-10T00:00:00Z') } });
    expect((await manager.post(`/ec-vouchers/${v.body.data.id}/reissue`).send({ issue_date: today })).status).toBe(201);

    const res = await admin.delete(`/staff-editing/students/${STUDENT.A2}/hard-delete`).send({ reason: 'Duplicate record created by mistake' });
    expect(res.status).toBeLessThan(300);

    expect(await prisma.students.findUnique({ where: { cc: STUDENT.A2 } })).toBeNull();
    expect(await prisma.ec_student_charges.count({ where: { student_id: STUDENT.A2 } })).toBe(0);
    expect(await prisma.ec_vouchers.count({ where: { student_id: STUDENT.A2 } })).toBe(0);
    expect(await prisma.ec_deposits.count({ where: { student_id: STUDENT.A2 } })).toBe(0);
    expect(await prisma.ec_voucher_lines.count()).toBe(0);
    expect(await prisma.ec_deposit_allocations.count()).toBe(0);
});
