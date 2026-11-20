/**
 * Support tickets "Sent" view (TAFSD-536): GET /support-tickets/sent lists the
 * caller's own staff replies with the review status a super admin gave them,
 * end to end through the real guards into a real Postgres.
 *
 * Covered: the status filter (single, several, all), the per-status counts
 * (which ignore the filter), newest-first order and pagination, the item shape
 * (snippet, reviewer, ticket context), the full reply -> reject flow through the
 * real endpoints, and that nobody, a super admin included, ever sees another
 * user's replies through it. Deleted replies and guardian messages never show.
 */
import type { INestApplication } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import { MessageStatus, StaffRole } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { bootApp, client, tokenFor } from './helpers/app';
import { STUDENT, USERS, seedSchool, type SeededUser } from './helpers/fixtures';

const TILE = 'communication.support_tickets';

/** Ticket responders for this file, on top of seedSchool()'s users. */
const RESPONDERS = {
    /** Holds the Support Tickets tile, so view/respond/reassign by default. */
    ayesha: { id: 'db-suite-responder-a', username: 'dbsuite.responder.a', role: StaffRole.PRINCIPAL },
    /** A second responder whose replies Ayesha must never see. */
    bilal: { id: 'db-suite-responder-b', username: 'dbsuite.responder.b', role: StaffRole.FINANCE_CLERK },
    /** Holds the tile with `respond` denied: only TileActionGuard can stop it. */
    noRespond: { id: 'db-suite-responder-c', username: 'dbsuite.responder.c', role: StaffRole.GENERAL_RESPONDENT },
} satisfies Record<string, SeededUser>;

const FAMILY_ID = 501;
const LANE_ID = 1;

let app: INestApplication;
let prisma: PrismaService;
let jwt: JwtService;
let as: Record<'admin' | 'viewer' | keyof typeof RESPONDERS, ReturnType<typeof client>>;

beforeAll(async () => {
    ({ app, prisma, jwt } = await bootApp());
    await seedSchool(prisma);

    for (const u of Object.values(RESPONDERS)) {
        await prisma.users.create({
            data: { id: u.id, username: u.username, full_name: u.username, role: u.role, password_hash: 'x', is_active: true },
        });
        await prisma.user_tile_grants.create({ data: { user_id: u.id, tile_id: TILE, allow: true, granted_by: USERS.admin.id } });
    }
    await prisma.user_tile_action_grants.create({
        data: { user_id: RESPONDERS.noRespond.id, tile_id: TILE, action_id: 'respond', allow: false, granted_by: USERS.admin.id },
    });

    await prisma.families.create({ data: { id: FAMILY_ID, household_name: 'Family of Test' } });
    await prisma.students.update({ where: { cc: STUDENT.A1 }, data: { family_id: FAMILY_ID } });
    // ticket_lanes is not part of seedSchool()'s reset, so upsert on a reused database.
    await prisma.ticket_lanes.upsert({
        where: { key: 'fees' },
        update: {},
        create: { id: LANE_ID, key: 'fees', name: 'Fees & Payments', icon: 'cash', color: '#0EA5E9', legacy_category: 'FINANCIAL' },
    });

    as = {
        admin: client(app, tokenFor(jwt, USERS.admin)),
        viewer: client(app, tokenFor(jwt, USERS.viewer)),
        ayesha: client(app, tokenFor(jwt, RESPONDERS.ayesha)),
        bilal: client(app, tokenFor(jwt, RESPONDERS.bilal)),
        noRespond: client(app, tokenFor(jwt, RESPONDERS.noRespond)),
    };
});

afterAll(async () => {
    await app?.close();
});

beforeEach(async () => {
    await prisma.$executeRawUnsafe(
        'TRUNCATE TABLE "ticket_messages", "ticket_events", "support_tickets", "audit_logs" RESTART IDENTITY CASCADE',
    );
});

// ─── helpers ────────────────────────────────────────────────────────────────

async function ticket(assignee: SeededUser, over: { student?: boolean; subtopic?: string } = {}) {
    return prisma.support_tickets.create({
        data: {
            family_id: FAMILY_ID,
            category: 'FINANCIAL',
            subtopic: over.subtopic ?? 'Fee query',
            student_id: over.student === false ? null : STUDENT.A1,
            description: 'Why is the fee higher this month?',
            status: 'ASSIGNED',
            current_assignee_id: assignee.id,
            routed_role: 'FINANCE_CLERK',
            lane_id: LANE_ID,
            flow_path: [
                { key: 'fees', type: 'LANE', label: 'Fees & Payments' },
                { key: 'adj', type: 'TOPIC', label: 'Fee adjustment' },
            ],
        },
    });
}

let clock = Date.parse('2026-11-01T08:00:00Z');
/** A staff reply, each one a minute after the last so ordering is deterministic. */
async function reply(
    ticketId: string,
    sender: SeededUser,
    status: MessageStatus,
    over: { content?: string; type?: 'TEXT' | 'IMAGE'; deleted?: boolean; comment?: string } = {},
) {
    clock += 60_000;
    const reviewed = status !== MessageStatus.PENDING;
    return prisma.ticket_messages.create({
        data: {
            ticket_id: ticketId,
            sender_type: 'STAFF',
            sender_user_id: sender.id,
            message_type: over.type ?? 'TEXT',
            content: over.content ?? `reply at ${clock}`,
            status,
            created_at: new Date(clock),
            reviewed_by: reviewed ? USERS.admin.id : null,
            reviewed_at: reviewed ? new Date(clock + 30_000) : null,
            review_comment: over.comment ?? null,
            deleted_at: over.deleted ? new Date(clock) : null,
        },
    });
}

/** Ayesha: 2 pending, 3 approved, 1 rejected (+1 deleted). Bilal: 1 of each. */
async function seedReplies() {
    const mine = await ticket(RESPONDERS.ayesha);
    const theirs = await ticket(RESPONDERS.bilal, { student: false, subtopic: 'Transport' });
    const ids = {
        p1: (await reply(mine.id, RESPONDERS.ayesha, MessageStatus.PENDING)).id,
        a1: (await reply(mine.id, RESPONDERS.ayesha, MessageStatus.APPROVED)).id,
        r1: (await reply(mine.id, RESPONDERS.ayesha, MessageStatus.REJECTED, { comment: 'Quote the voucher number' })).id,
        a2: (await reply(mine.id, RESPONDERS.ayesha, MessageStatus.APPROVED, { type: 'IMAGE', content: 'https://cdn.test/x.png' })).id,
        gone: (await reply(mine.id, RESPONDERS.ayesha, MessageStatus.APPROVED, { deleted: true })).id,
        a3: (await reply(mine.id, RESPONDERS.ayesha, MessageStatus.APPROVED)).id,
        p2: (await reply(mine.id, RESPONDERS.ayesha, MessageStatus.PENDING)).id,
        bp: (await reply(theirs.id, RESPONDERS.bilal, MessageStatus.PENDING)).id,
        ba: (await reply(theirs.id, RESPONDERS.bilal, MessageStatus.APPROVED)).id,
        br: (await reply(theirs.id, RESPONDERS.bilal, MessageStatus.REJECTED, { comment: 'Not ours' })).id,
    };
    // A guardian message on the same ticket is not anyone's "sent" reply.
    await prisma.ticket_messages.create({
        data: { ticket_id: mine.id, sender_type: 'GUARDIAN', message_type: 'TEXT', content: 'Thanks', status: MessageStatus.APPROVED },
    });
    return { mine, theirs, ids };
}

const ids = (res: { body: { items: { id: string }[] } }) => res.body.items.map((i) => i.id);

// ─── the list ───────────────────────────────────────────────────────────────

describe('GET /support-tickets/sent', () => {
    it('lists only the caller\'s own undeleted replies, newest first, with counts', async () => {
        const { ids: m } = await seedReplies();
        const res = await as.ayesha.get('/support-tickets/sent');
        expect(res.status).toBe(200);
        expect(ids(res)).toEqual([m.p2, m.a3, m.a2, m.r1, m.a1, m.p1]);
        expect(res.body).toMatchObject({
            total: 6,
            take: 50,
            skip: 0,
            counts: { all: 6, pending: 2, approved: 3, rejected: 1 },
        });
    });

    it.each([
        ['pending', ['p2', 'p1'], 2],
        ['approved', ['a3', 'a2', 'a1'], 3],
        ['rejected', ['r1'], 1],
        ['APPROVED,rejected', ['a3', 'a2', 'r1', 'a1'], 4],
        ['all', ['p2', 'a3', 'a2', 'r1', 'a1', 'p1'], 6],
    ])('filters by status=%s and keeps every count', async (status, expected, total) => {
        const { ids: m } = await seedReplies();
        const res = await as.ayesha.get(`/support-tickets/sent?status=${status}`);
        expect(res.status).toBe(200);
        expect(ids(res)).toEqual(expected.map((k) => m[k as keyof typeof m]));
        expect(res.body.total).toBe(total);
        expect(res.body.counts).toEqual({ all: 6, pending: 2, approved: 3, rejected: 1 });
    });

    it('rejects an unknown status and bad pagination', async () => {
        expect((await as.ayesha.get('/support-tickets/sent?status=deleted')).status).toBe(400);
        expect((await as.ayesha.get('/support-tickets/sent?take=0')).status).toBe(400);
    });

    it('pages with take and skip', async () => {
        const { ids: m } = await seedReplies();
        const res = await as.ayesha.get('/support-tickets/sent?take=2&skip=2');
        expect(res.status).toBe(200);
        expect(ids(res)).toEqual([m.a2, m.r1]);
        expect(res.body).toMatchObject({ total: 6, take: 2, skip: 2 });
    });

    it('returns the snippet, the review, and the ticket context', async () => {
        const { mine, ids: m } = await seedReplies();
        const res = await as.ayesha.get('/support-tickets/sent?status=rejected,approved');
        const byId = Object.fromEntries(res.body.items.map((i: any) => [i.id, i]));

        expect(byId[m.r1]).toMatchObject({
            message_type: 'TEXT',
            status: 'REJECTED',
            review_comment: 'Quote the voucher number',
            reviewer: { id: USERS.admin.id, full_name: USERS.admin.username },
            ticket: {
                id: mine.id,
                status: 'ASSIGNED',
                category: 'FINANCIAL',
                topic: 'Fee adjustment',
                lane_name: 'Fees & Payments',
                lane: { key: 'fees', name: 'Fees & Payments' },
                families: { id: FAMILY_ID, household_name: 'Family of Test' },
                students: { cc: STUDENT.A1, full_name: 'Test Student One' },
            },
        });
        expect(typeof byId[m.r1].snippet).toBe('string');
        expect(byId[m.r1].reviewed_at).toBeTruthy();
        expect(byId[m.r1]).not.toHaveProperty('content');
        expect(byId[m.a2].snippet).toBe('[IMAGE]');
    });
});

// ─── nobody sees anyone else's replies ──────────────────────────────────────

describe('isolation', () => {
    it('gives each responder only their own replies and counts', async () => {
        const { ids: m } = await seedReplies();
        const res = await as.bilal.get('/support-tickets/sent');
        expect(res.status).toBe(200);
        expect(ids(res)).toEqual([m.br, m.ba, m.bp]);
        expect(res.body.counts).toEqual({ all: 3, pending: 1, approved: 1, rejected: 1 });
        expect(res.body.items[0].ticket.students).toBeNull();
    });

    it('does not show a super admin anyone else\'s replies', async () => {
        await seedReplies();
        const res = await as.admin.get('/support-tickets/sent');
        expect(res.status).toBe(200);
        expect(res.body.items).toEqual([]);
        expect(res.body.counts).toEqual({ all: 0, pending: 0, approved: 0, rejected: 0 });
    });

    it('ignores any attempt to name another sender', async () => {
        const { ids: m } = await seedReplies();
        const res = await as.ayesha.get(`/support-tickets/sent?sender_user_id=${RESPONDERS.bilal.id}&userId=${RESPONDERS.bilal.id}`);
        expect(res.status).toBe(200);
        expect(ids(res)).not.toEqual(expect.arrayContaining([m.bp]));
        expect(res.body.total).toBe(6);
    });
});

// ─── guards ─────────────────────────────────────────────────────────────────

describe('access', () => {
    it('refuses a user without the Support Tickets tile', async () => {
        expect((await as.viewer.get('/support-tickets/sent')).status).toBe(403);
    });

    it('refuses a responder whose respond action is denied', async () => {
        expect((await as.noRespond.get('/support-tickets/sent')).status).toBe(403);
    });

    it('refuses an anonymous request', async () => {
        const res = await client(app, 'not-a-token').get('/support-tickets/sent');
        expect(res.status).toBe(401);
    });
});

// ─── through the real reply and review endpoints ────────────────────────────

describe('reply, then review', () => {
    it('moves a reply from Pending to Rejected with the reason and reviewer', async () => {
        const t = await ticket(RESPONDERS.ayesha);
        const sent = await as.ayesha.post(`/support-tickets/${t.id}/messages`).send({ messageType: 'TEXT', content: 'Your fee is correct.' });
        expect(sent.status).toBe(201);
        const messageId = sent.body.id;

        let res = await as.ayesha.get('/support-tickets/sent?status=pending');
        expect(ids(res)).toEqual([messageId]);
        expect(res.body.items[0]).toMatchObject({ status: 'PENDING', snippet: 'Your fee is correct.', reviewer: null, reviewed_at: null });

        const reviewed = await as.admin
            .patch(`/support-tickets/messages/${messageId}/review`)
            .send({ status: 'REJECTED', comment: 'Explain the arrears too' });
        expect(reviewed.status).toBe(200);

        res = await as.ayesha.get('/support-tickets/sent?status=rejected');
        expect(ids(res)).toEqual([messageId]);
        expect(res.body.items[0]).toMatchObject({
            status: 'REJECTED',
            review_comment: 'Explain the arrears too',
            reviewer: { id: USERS.admin.id, full_name: USERS.admin.username },
        });
        expect(res.body.counts).toEqual({ all: 1, pending: 0, approved: 0, rejected: 1 });
        expect((await as.ayesha.get('/support-tickets/sent?status=pending')).body.items).toEqual([]);
    });

    it('lists a super admin\'s own reply as approved straight away', async () => {
        const t = await ticket(RESPONDERS.ayesha);
        const sent = await as.admin.post(`/support-tickets/${t.id}/messages`).send({ messageType: 'TEXT', content: 'Sorted.' });
        expect(sent.status).toBe(201);
        const res = await as.admin.get('/support-tickets/sent');
        expect(res.body.items).toHaveLength(1);
        expect(res.body.items[0]).toMatchObject({ status: 'APPROVED', snippet: 'Sorted.' });
        expect(res.body.counts).toEqual({ all: 1, pending: 0, approved: 1, rejected: 0 });
        // ...and it is still not in Ayesha's list.
        expect((await as.ayesha.get('/support-tickets/sent')).body.total).toBe(0);
    });
});

// TAFSD-542: a lane removed from the flow is only soft-deleted (is_active false).
// The lane filter keeps it only while tickets are filed under it.
describe('lane filter (GET /support-tickets/lanes)', () => {
    // Fixed ids: the fixture inserts the fees lane by id, so the sequence is not advanced.
    const lane = (id: number, key: string, is_active: boolean) =>
        prisma.ticket_lanes.upsert({
            where: { key },
            update: { is_active },
            create: { id, key, name: key, icon: 'tag', color: '#64748B', legacy_category: 'GENERAL', is_active },
        });

    afterAll(async () => {
        await prisma.ticket_lanes.deleteMany({ where: { key: { in: ['deleted-unused', 'deleted-used'] } } });
    });

    it('drops a deleted lane nobody used, keeps a deleted lane that still has tickets', async () => {
        await lane(9101, 'deleted-unused', false);
        const used = await lane(9102, 'deleted-used', false);
        const t = await ticket(RESPONDERS.ayesha);
        await prisma.support_tickets.update({ where: { id: t.id }, data: { lane_id: used.id } });

        const res = await as.ayesha.get('/support-tickets/lanes');
        expect(res.status).toBe(200);
        const keys = (res.body.data ?? res.body).map((l: { key: string }) => l.key);
        expect(keys).toContain('fees');
        expect(keys).toContain('deleted-used');
        expect(keys).not.toContain('deleted-unused');
    });
});
