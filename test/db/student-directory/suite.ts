import type { INestApplication } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type { PrismaService } from '../../../prisma/prisma.service';
import { bootApp, client, tokenFor } from '../helpers/app';
import { USERS } from '../helpers/fixtures';
import { DIR_USERS, seedDirectory } from './directory-fixtures';

type Who = 'admin' | keyof typeof DIR_USERS;

export type DirectoryContext = {
    app: INestApplication;
    prisma: PrismaService;
    jwt: JwtService;
    as: Record<Who, ReturnType<typeof client>>;
    ids: { fatherId: number; motherId: number };
    /** No Authorization header at all. */
    anon: () => ReturnType<typeof request>;
};

/**
 * Boots the app once per file and reseeds the directory before every test,
 * so each test starts from the same school regardless of what the last one
 * changed.
 */
export function directorySuite(): DirectoryContext {
    const ctx = {} as DirectoryContext;
    beforeAll(async () => {
        Object.assign(ctx, await bootApp());
        const who = { admin: USERS.admin, ...DIR_USERS };
        ctx.as = Object.fromEntries(
            Object.entries(who).map(([k, u]) => [k, client(ctx.app, tokenFor(ctx.jwt, u))]),
        ) as DirectoryContext['as'];
        ctx.anon = () => request(ctx.app.getHttpServer());
    });
    afterAll(async () => {
        await ctx.app?.close();
    });
    beforeEach(async () => {
        ctx.ids = await seedDirectory(ctx.prisma);
    });
    return ctx;
}
