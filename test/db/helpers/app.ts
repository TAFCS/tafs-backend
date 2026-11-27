import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../../../src/app.module';
import { applyGlobalPipeline } from '../../../src/app.pipeline';
import { PrismaService } from '../../../prisma/prisma.service';
import { resetClassTermMapCache } from '../../../src/common/utils/class-terms.util';
import type { SeededUser } from './fixtures';

/**
 * Boots the real AppModule (every module, every guard) against the throwaway
 * database, with the same global pipeline as src/main.ts. Requests go through
 * supertest, so JwtStaffGuard -> PoliciesGuard -> TileActionGuard and the
 * ValidationPipe all run exactly as they do in production.
 */
export async function bootApp(): Promise<{ app: INestApplication; prisma: PrismaService; jwt: JwtService }> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication({ logger: ['error'] });
    applyGlobalPipeline(app);
    app.use(cookieParser());
    // Listen once, so every supertest request reuses this server instead of
    // opening (and racing) an ephemeral listener per request.
    await app.listen(0, '127.0.0.1');

    const prisma = app.get(PrismaService);
    // StudentFlagsService installs its trigger in the background on boot. Let it
    // finish so it never races app.close() at the end of the file.
    for (let i = 0; i < 50; i++) {
        const [row] = await prisma.$queryRaw<{ exists: boolean }[]>`
            SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_student_flag_notify') AS "exists"`;
        if (row?.exists) break;
        await new Promise((r) => setTimeout(r, 100));
    }
    resetClassTermMapCache();
    return { app, prisma, jwt: app.get(JwtService) };
}

/** A staff access token for a seeded user. The strategy re-reads role, tiles,
 * actions and scope from the database on every request, as in production. */
export function tokenFor(jwt: JwtService, user: SeededUser): string {
    return jwt.sign({
        sub: user.id,
        username: user.username,
        fullName: user.username,
        role: user.role,
        campusId: null,
        allowedClassIds: [],
        userType: 'STAFF',
        permissions: [],
    });
}

/** supertest bound to one user: `as(token).post('/student-fees/bulk')`. */
export function client(app: INestApplication, token: string) {
    const server = app.getHttpServer();
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
    return {
        get: (path: string) => auth(request(server).get(`/api/v1${path}`)),
        post: (path: string) => auth(request(server).post(`/api/v1${path}`)),
        patch: (path: string) => auth(request(server).patch(`/api/v1${path}`)),
        put: (path: string) => auth(request(server).put(`/api/v1${path}`)),
        delete: (path: string) => auth(request(server).delete(`/api/v1${path}`)),
    };
}
