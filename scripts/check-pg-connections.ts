/**
 * Read-only: how many clients are connected to DATABASE_URL.
 *
 *   npx ts-node scripts/check-pg-connections.ts
 *
 * Use when you see "FATAL: sorry, too many clients already". Stop local Nest /
 * leftover scripts if the count is near max_connections.
 */
import { PrismaClient } from '@prisma/client';

async function main() {
  const raw = process.env.DATABASE_URL || '';
  let host = '(unset)';
  let limit = '(default)';
  try {
    const u = new URL(raw);
    host = `${u.hostname}:${u.port || '5432'}`;
    limit = u.searchParams.get('connection_limit') ?? '(unset → app defaults to 5)';
  } catch {
    /* ignore */
  }
  console.log(`DATABASE_URL host: ${host}`);
  console.log(`connection_limit in URL: ${limit}`);

  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: raw.includes('connection_limit')
          ? raw
          : `${raw}${raw.includes('?') ? '&' : '?'}connection_limit=1`,
      },
    },
  });

  try {
    const max = await prisma.$queryRaw<Array<{ max_connections: number }>>`
      SELECT current_setting('max_connections')::int AS max_connections
    `;
    const rows = await prisma.$queryRaw<
      Array<{ count: bigint; state: string | null; application_name: string }>
    >`
      SELECT count(*)::bigint AS count,
             state,
             coalesce(nullif(application_name, ''), '(none)') AS application_name
      FROM pg_stat_activity
      WHERE datname = current_database()
      GROUP BY state, application_name
      ORDER BY count DESC
    `;
    const total = rows.reduce((n, r) => n + Number(r.count), 0);
    console.log(`max_connections: ${max[0]?.max_connections}`);
    console.log(`current clients on this database: ${total}`);
    console.log('by state / application_name:');
    for (const r of rows) {
      console.log(`  ${String(r.count).padStart(4)}  state=${r.state ?? 'null'}  app=${r.application_name}`);
    }
    if (total > Number(max[0]?.max_connections || 0) * 0.8) {
      console.warn(
        '\nWARNING: over 80% of max_connections in use. Stop local Nest/scripts or lower connection_limit.',
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
