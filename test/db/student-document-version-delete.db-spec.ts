/**
 * Student documents: delete a wrong version (TAFSD-541), end to end through the
 * real guards into a real Postgres.
 *
 * Covered: deleting v3 of 3 leaves v2 current with v1/v2 still viewable;
 * deleting the only version takes the document off file so its required slot
 * reads missing again (vault, summary and missing-documents report); a deleted
 * version's link is refused; no `#delete` gives 403; an out-of-scope student is
 * refused; version numbers are never reused (upload and make-current); the
 * audit row; a storage failure still marks the row deleted; a file still used
 * by another version (make-current copy) stays in storage; archive unchanged.
 */
import type { INestApplication } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import { StaffRole } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../../src/common/storage/storage.service';
import { bootApp, client, tokenFor } from './helpers/app';
import { CAMPUS_A, STUDENT, USERS, seedSchool, type SeededUser } from './helpers/fixtures';

const TILE = 'student.documents';

const STAFF = {
    /** Files, replaces, archives and deletes; campus A only. */
    keeper: { id: 'db-suite-docs-keeper', username: 'dbsuite.docs.keeper', role: StaffRole.PRINCIPAL },
    /** Files, replaces and archives, but does not hold #delete. */
    noDelete: { id: 'db-suite-docs-nodelete', username: 'dbsuite.docs.nodelete', role: StaffRole.PRINCIPAL },
} satisfies Record<string, SeededUser>;

const REASON = 'Wrong student: this is her sister\'s B-Form';

let app: INestApplication;
let prisma: PrismaService;
let jwt: JwtService;
let storage: StorageService;
let as: Record<'admin' | 'viewer' | keyof typeof STAFF, ReturnType<typeof client>>;
let typeId: number;

beforeAll(async () => {
    ({ app, prisma, jwt } = await bootApp());
    storage = app.get(StorageService);
    await seedSchool(prisma);

    for (const u of Object.values(STAFF)) {
        await prisma.users.create({
            data: { id: u.id, username: u.username, full_name: u.username, role: u.role, password_hash: 'x', is_active: true },
        });
        await prisma.user_tile_grants.create({ data: { user_id: u.id, tile_id: TILE, allow: true, granted_by: USERS.admin.id } });
        await prisma.user_scope_entries.create({ data: { user_id: u.id, dimension: 'CAMPUS', ref_id: CAMPUS_A } });
    }
    const grant = (u: SeededUser, actionId: string) =>
        prisma.user_tile_action_grants.create({
            data: { user_id: u.id, tile_id: TILE, action_id: actionId, allow: true, granted_by: USERS.admin.id },
        });
    for (const a of ['upload', 'replace', 'archive', 'delete']) await grant(STAFF.keeper, a);
    for (const a of ['upload', 'replace', 'archive']) await grant(STAFF.noDelete, a);

    as = {
        admin: client(app, tokenFor(jwt, USERS.admin)),
        viewer: client(app, tokenFor(jwt, USERS.viewer)),
        keeper: client(app, tokenFor(jwt, STAFF.keeper)),
        noDelete: client(app, tokenFor(jwt, STAFF.noDelete)),
    };
});

afterAll(async () => {
    await app?.close();
});

beforeEach(async () => {
    jest.restoreAllMocks();
    // Storage is not configured in the suite: uploads and deletes are mocked by
    // StorageService itself; a signed link needs a stand-in.
    jest.spyOn(storage, 'getSignedUrl').mockImplementation(async (key: string) => `https://signed.test/${key}`);
    await prisma.$executeRawUnsafe(
        'TRUNCATE TABLE "student_document_versions", "student_documents", "student_document_types", "audit_logs" RESTART IDENTITY CASCADE',
    );
    const type = await prisma.student_document_types.create({
        data: { code: 'B_FORM', name: 'B-Form / CNIC', owner: 'STUDENT', required_at_admission: true, display_order: 10 },
    });
    typeId = type.id;
});

// ─── helpers ────────────────────────────────────────────────────────────────

/** Files one version through the real upload endpoint. Distinct bytes per call. */
async function upload(who: ReturnType<typeof client>, cc: number, name: string) {
    const res = await who
        .post(`/student-documents/students/${cc}/upload`)
        .field('type_id', String(typeId))
        .attach('files', Buffer.from(`scan ${name} ${Math.random()}`), { filename: name, contentType: 'image/png' });
    expect(res.status).toBe(201);
    return res.body.data as { document_id: number; version: { id: number; version_no: number }; replaced: boolean };
}

/** v1, v2, v3 of one B-Form on student A1. */
async function threeVersions() {
    const v1 = await upload(as.keeper, STUDENT.A1, 'bform-1.png');
    const v2 = await upload(as.keeper, STUDENT.A1, 'bform-2.png');
    const v3 = await upload(as.keeper, STUDENT.A1, 'bform-3.png');
    return { docId: v1.document_id, v1: v1.version.id, v2: v2.version.id, v3: v3.version.id };
}

/** `reason: null` sends no reason at all. */
const del = (who: ReturnType<typeof client>, versionId: number, reason: string | null = REASON) =>
    who.delete(`/student-documents/versions/${versionId}`).send(reason === null ? {} : { reason });

const vault = async (cc: number = STUDENT.A1) => {
    const res = await as.keeper.get(`/student-documents/students/${cc}`);
    expect(res.status).toBe(200);
    return res.body.data;
};

// ─── tests ──────────────────────────────────────────────────────────────────

describe('DELETE /student-documents/versions/:id', () => {
    it('deleting v3 of 3 makes v2 current; v1 and v2 stay viewable; the file is removed', async () => {
        const removed = jest.spyOn(storage, 'deleteByKey');
        const { docId, v1, v2, v3 } = await threeVersions();
        const key = (await prisma.student_document_versions.findUniqueOrThrow({ where: { id: v3 } })).storage_key;

        const res = await del(as.keeper, v3);
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({
            document_id: docId,
            version_no: 3,
            remaining_versions: 2,
            current_version_id: v2,
            current_version_no: 2,
            on_file: true,
            file_removed: true,
        });
        expect(removed).toHaveBeenCalledWith(key);

        const row = await prisma.student_document_versions.findUniqueOrThrow({ where: { id: v3 } });
        expect(row.deleted_at).toBeInstanceOf(Date);
        expect(row.deleted_by).toBe(STAFF.keeper.username);
        expect(row.delete_reason).toBe(REASON);

        const data = await vault();
        expect(data.documents).toHaveLength(1);
        expect(data.documents[0].current.id).toBe(v2);
        expect(data.documents[0].versions.map((v: { version_no: number }) => v.version_no)).toEqual([2, 1]);
        expect(data.missing).toEqual([]);

        for (const id of [v1, v2]) {
            expect((await as.keeper.get(`/student-documents/versions/${id}/link`)).status).toBe(200);
        }
    });

    it('deleting the only version takes the document off file, so the slot reads missing again', async () => {
        const only = await upload(as.keeper, STUDENT.A1, 'only.png');
        expect((await vault()).missing).toEqual([]);

        const res = await del(as.keeper, only.version.id);
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ remaining_versions: 0, current_version_id: null, on_file: false });

        const data = await vault();
        expect(data.documents).toEqual([]);
        expect(data.missing.map((m: { type_code: string }) => m.type_code)).toEqual(['B_FORM']);
        expect(data.completeness).toEqual({ required: 1, on_file: 0 });

        const summary = await as.keeper.get(`/student-documents/summary?ccs=${STUDENT.A1}`);
        expect(summary.body.data).toEqual([{ cc: STUDENT.A1, required: 1, on_file: 0, missing: ['B-Form / CNIC'] }]);

        const report = await as.keeper.get('/student-documents/missing');
        expect(report.status).toBe(200);
        expect(report.body.data.items.map((r: { cc: number }) => r.cc)).toContain(STUDENT.A1);

        const types = await as.keeper.get('/student-documents/types');
        expect(types.body.data.find((t: { id: number }) => t.id === typeId).document_count).toBe(0);

        // The document row is kept (not archived), with its deleted version as the record.
        const doc = await prisma.student_documents.findUniqueOrThrow({ where: { id: only.document_id } });
        expect(doc.archived_at).toBeNull();
    });

    it("refuses a deleted version's link", async () => {
        const { v3 } = await threeVersions();
        expect((await del(as.keeper, v3)).status).toBe(200);
        const link = await as.keeper.get(`/student-documents/versions/${v3}/link`);
        expect(link.status).toBe(404);
        expect(storage.getSignedUrl).not.toHaveBeenCalled();
    });

    it('refuses a caller without #delete (403), and the version is untouched', async () => {
        const { v3 } = await threeVersions();
        expect((await del(as.noDelete, v3)).status).toBe(403);
        expect((await del(as.viewer, v3)).status).toBe(403);
        const row = await prisma.student_document_versions.findUniqueOrThrow({ where: { id: v3 } });
        expect(row.deleted_at).toBeNull();
        expect((await vault()).documents[0].current.id).toBe(v3);
    });

    it("refuses a student outside the caller's scope", async () => {
        const theirs = await upload(as.admin, STUDENT.B1, 'campus-b.png');
        const res = await del(as.keeper, theirs.version.id);
        expect(res.status).toBe(404);
        const row = await prisma.student_document_versions.findUniqueOrThrow({ where: { id: theirs.version.id } });
        expect(row.deleted_at).toBeNull();
        // A super admin reaches every campus.
        expect((await del(as.admin, theirs.version.id)).status).toBe(200);
    });

    it('requires a reason of a few characters', async () => {
        const { v3 } = await threeVersions();
        expect((await del(as.keeper, v3, null)).status).toBe(400);
        expect((await del(as.keeper, v3, '  no ')).status).toBe(400);
        const row = await prisma.student_document_versions.findUniqueOrThrow({ where: { id: v3 } });
        expect(row.deleted_at).toBeNull();
    });

    it('refuses deleting the same version twice', async () => {
        const { v3 } = await threeVersions();
        expect((await del(as.keeper, v3)).status).toBe(200);
        expect((await del(as.keeper, v3)).status).toBe(400);
    });

    it('never reuses a version number', async () => {
        const { docId, v3 } = await threeVersions();
        expect((await del(as.keeper, v3)).status).toBe(200);
        const next = await upload(as.keeper, STUDENT.A1, 'bform-clear.png');
        expect(next.document_id).toBe(docId);
        expect(next.version.version_no).toBe(4);
        expect(next.replaced).toBe(true);

        // Deleting the only version: the next upload files into the same
        // document as a new filing (needs #upload, logged UPLOADED), numbered on.
        const only = await upload(as.keeper, STUDENT.A2, 'a2.png');
        expect((await del(as.keeper, only.version.id)).status).toBe(200);
        const again = await upload(as.keeper, STUDENT.A2, 'a2-again.png');
        expect(again.document_id).toBe(only.document_id);
        expect(again.version.version_no).toBe(2);
        expect(again.replaced).toBe(false);
        expect((await vault(STUDENT.A2)).missing).toEqual([]);
    });

    it('make-current numbers on past a deleted version and skips deleted ones', async () => {
        const { docId, v1, v3 } = await threeVersions();
        expect((await del(as.keeper, v3)).status).toBe(200);
        // v3 is deleted: it cannot be brought back.
        expect((await as.keeper.post(`/student-documents/${docId}/versions/${v3}/make-current`)).status).toBe(404);
        const res = await as.keeper.post(`/student-documents/${docId}/versions/${v1}/make-current`);
        expect(res.status).toBe(201);
        expect(res.body.data.version_no).toBe(4);
    });

    it("keeps the file when another version still uses it (a make-current copy)", async () => {
        const removed = jest.spyOn(storage, 'deleteByKey');
        const { docId, v1 } = await threeVersions();
        const copy = await as.keeper.post(`/student-documents/${docId}/versions/${v1}/make-current`);
        expect(copy.status).toBe(201);
        const res = await del(as.keeper, copy.body.data.id);
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ file_removed: false, current_version_no: 3 });
        expect(removed).not.toHaveBeenCalled();
        expect((await as.keeper.get(`/student-documents/versions/${v1}/link`)).status).toBe(200);
    });

    it('still marks the version deleted when storage fails to remove the file', async () => {
        jest.spyOn(storage, 'deleteByKey').mockRejectedValue(new Error('spaces is down'));
        const { v2, v3 } = await threeVersions();
        const res = await del(as.keeper, v3);
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ file_removed: false, current_version_id: v2 });
        const row = await prisma.student_document_versions.findUniqueOrThrow({ where: { id: v3 } });
        expect(row.deleted_at).toBeInstanceOf(Date);
    });

    it('writes a VERSION_DELETED audit row, without the file', async () => {
        const { docId, v3 } = await threeVersions();
        expect((await del(as.keeper, v3)).status).toBe(200);
        const rows = await prisma.audit_logs.findMany({ where: { action: 'VERSION_DELETED' } });
        expect(rows).toHaveLength(1);
        const [row] = rows;
        expect(row).toMatchObject({
            entity_type: 'STUDENT_DOCUMENT',
            entity_id: String(docId),
            field: 'B_FORM',
            changed_by: STAFF.keeper.username,
            student_id: STUDENT.A1,
            new_value: REASON,
        });
        expect(JSON.parse(row.old_value!)).toMatchObject({
            document_id: docId,
            version_id: v3,
            version_no: 3,
            original_filename: 'bform-3.png',
        });
        expect(row.note).toContain('bform-3.png');
        expect(row.note).toContain(REASON);
        expect(row.old_value).not.toContain('scan ');

        const activity = await as.keeper.get('/student-documents/activity');
        expect(activity.body.data.map((a: { action: string }) => a.action)).toContain('VERSION_DELETED');
    });

    it('leaves archive working as before', async () => {
        const { docId } = await threeVersions();
        const archived = await as.keeper.post(`/student-documents/${docId}/archive`).send({ reason: 'Filed on the wrong student' });
        expect(archived.status).toBe(201);
        let data = await vault();
        expect(data.documents[0].archived_at).toBeTruthy();
        expect(data.documents[0].versions).toHaveLength(3);
        expect(data.missing.map((m: { type_code: string }) => m.type_code)).toEqual(['B_FORM']);
        expect((await as.keeper.post(`/student-documents/${docId}/restore`)).status).toBe(201);
        data = await vault();
        expect(data.documents[0].archived_at).toBeNull();
        expect(data.missing).toEqual([]);
    });
});
