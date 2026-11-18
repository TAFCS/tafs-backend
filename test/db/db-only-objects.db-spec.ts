/**
 * Guard for test/db/db-only-objects.sql.
 *
 * The test database is built from schema.prisma, which cannot express
 * triggers, partial unique indexes or CHECK constraints, plus that file. If a
 * new migration adds one of those and nobody copies it into the file, the
 * suite would quietly test a database production does not have. This replays
 * the migrations' DDL for those three kinds of object, in order (so later
 * DROPs win), and fails until every one still standing exists here too.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';

const MIGRATIONS = join(__dirname, '../../prisma/migrations');

type Kind = 'trigger' | 'index' | 'check';

/** Objects the migrations leave standing, by kind and name. */
function expectedObjects(): Map<string, Kind> {
    const live = new Map<string, Kind>();
    const dirs = readdirSync(MIGRATIONS, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();

    const name = String.raw`"?([A-Za-z0-9_]+)"?`;
    const rules: { re: RegExp; act: (m: RegExpExecArray) => void }[] = [
        { re: new RegExp(String.raw`CREATE\s+TRIGGER\s+${name}`, 'gi'), act: (m) => live.set(m[1], 'trigger') },
        { re: new RegExp(String.raw`DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?${name}`, 'gi'), act: (m) => live.delete(m[1]) },
        // Partial unique indexes only: a plain one is in schema.prisma already.
        {
            re: new RegExp(String.raw`CREATE\s+UNIQUE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?${name}\s+ON\s+[^;]*?\bWHERE\b[^;]*;`, 'gi'),
            act: (m) => live.set(m[1], 'index'),
        },
        { re: new RegExp(String.raw`DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?${name}`, 'gi'), act: (m) => live.delete(m[1]) },
        { re: new RegExp(String.raw`CONSTRAINT\s+${name}\s+CHECK\s*\(`, 'gi'), act: (m) => live.set(m[1], 'check') },
        { re: new RegExp(String.raw`DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?${name}`, 'gi'), act: (m) => live.delete(m[1]) },
    ];

    for (const dir of dirs) {
        let sql: string;
        try {
            sql = readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8');
        } catch {
            continue;
        }
        sql = sql.replace(/--[^\n]*/g, '');
        // Apply every statement in file order, so a DROP after a CREATE in the
        // same migration (or a later one) removes it.
        const events: { at: number; run: () => void }[] = [];
        for (const { re, act } of rules) {
            re.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = re.exec(sql))) {
                const match = m;
                events.push({ at: match.index, run: () => act(match) });
            }
        }
        events.sort((a, b) => a.at - b.at).forEach((e) => e.run());
    }
    return live;
}

describe('test database matches the DB-only objects in prisma/migrations', () => {
    const prisma = new PrismaClient();
    afterAll(() => prisma.$disconnect());

    it('has every trigger, partial unique index and CHECK constraint the migrations leave standing', async () => {
        const expected = expectedObjects();
        // Sanity: the parser found the ones this suite depends on.
        expect(expected.get('trg_student_fees_amount_invariants')).toBe('trigger');

        const triggers = await prisma.$queryRaw<{ name: string }[]>`
            SELECT tgname AS name FROM pg_trigger WHERE NOT tgisinternal`;
        const indexes = await prisma.$queryRaw<{ name: string }[]>`
            SELECT indexname AS name FROM pg_indexes WHERE schemaname = 'public'`;
        const checks = await prisma.$queryRaw<{ name: string }[]>`
            SELECT conname AS name FROM pg_constraint WHERE contype = 'c'`;
        const present: Record<Kind, Set<string>> = {
            trigger: new Set(triggers.map((r) => r.name)),
            index: new Set(indexes.map((r) => r.name)),
            check: new Set(checks.map((r) => r.name)),
        };

        const missing = [...expected].filter(([n, kind]) => !present[kind].has(n)).map(([n, kind]) => `${kind} ${n}`);
        // Copy each missing object from its migration into test/db/db-only-objects.sql.
        expect(missing).toEqual([]);
    });
});
