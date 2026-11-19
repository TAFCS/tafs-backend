/**
 * The DB suite truncates every table. It must never reach a real database:
 * the repo's .env points at PRODUCTION. Refuse unless DATABASE_URL is set
 * explicitly, points at a local / CI-service host, and names a *test* database.
 */
export function assertThrowawayDatabase(): string {
    const raw = process.env.DATABASE_URL;
    if (!raw) {
        throw new Error(
            'DB suite: DATABASE_URL is not set. Point it at a throwaway Postgres, e.g. ' +
            'postgresql://postgres:postgres@localhost:5432/tafs_test (see test/db/README.md).',
        );
    }
    const url = new URL(raw);
    const okHost = ['localhost', '127.0.0.1', 'postgres'].includes(url.hostname);
    const okName = url.pathname.slice(1).includes('test');
    if (!okHost || !okName) {
        throw new Error(
            `DB suite refuses to run against ${url.hostname}/${url.pathname.slice(1)}: ` +
            'it truncates every table. Use a local database whose name contains "test".',
        );
    }
    return raw;
}
