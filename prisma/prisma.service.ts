import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/** Default when DATABASE_URL omits connection_limit. Keep low: DO plans are tiny and local+Railway share one DB. */
const DEFAULT_CONNECTION_LIMIT = 5;

function getOptimizedDatabaseUrl(): { url: string; connectionLimit: number } | undefined {
  const raw = process.env.DATABASE_URL;
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    const existing = url.searchParams.get('connection_limit');
    // DB_CONNECTION_LIMIT lets a deploy size the pool without editing the
    // DATABASE_URL secret. Size it against the PgBouncer pool, not the raw
    // DB max_connections.
    const override = Number(process.env.DB_CONNECTION_LIMIT);
    if (Number.isInteger(override) && override > 0) {
      url.searchParams.set('connection_limit', String(override));
    } else if (!existing) {
      // Respect an explicit limit (scripts use 1–3). Only default when unset —
      // never raise a low value to 10 (that exhausted DO max_connections).
      url.searchParams.set('connection_limit', String(DEFAULT_CONNECTION_LIMIT));
    }
    const connectionLimit = Number(url.searchParams.get('connection_limit'));
    // Fail fast when the pool is saturated.
    if (!url.searchParams.has('pool_timeout')) {
      url.searchParams.set('pool_timeout', '10');
    }
    if (!url.searchParams.has('connect_timeout')) {
      url.searchParams.set('connect_timeout', '5');
    }
    // Do NOT put lock_timeout/statement_timeout in URL `options` — DigitalOcean
    // PgBouncer rejects them: FATAL: unsupported startup parameter in options.
    url.searchParams.delete('options');
    return { url: url.toString(), connectionLimit };
  } catch {
    return { url: raw, connectionLimit: DEFAULT_CONNECTION_LIMIT };
  }
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  /** Size of this client's connection pool; batch jobs size their concurrency from it. */
  readonly connectionLimit: number;

  constructor() {
    const optimized = getOptimizedDatabaseUrl();
    super({
      ...(optimized ? { datasources: { db: { url: optimized.url } } } : {}),
      log: [
        { emit: 'stdout', level: 'warn' },
        { emit: 'stdout', level: 'error' },
      ],
    });
    this.connectionLimit = optimized?.connectionLimit ?? DEFAULT_CONNECTION_LIMIT;
  }

  async onModuleInit() {
    const CONNECT_MS = 10_000;
    // console.log (not Nest Logger): production NestFactory logger is warn/error
    // only, so Logger.log never appears in Railway Deploy Logs.
    // eslint-disable-next-line no-console
    console.log(
      `[boot] Prisma $connect (timeout ${CONNECT_MS}ms, connection_limit=${this.connectionLimit})…`,
    );
    await Promise.race([
      this.$connect(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Prisma $connect timed out after ${CONNECT_MS}ms`)),
          CONNECT_MS,
        ),
      ),
    ]);
    // eslint-disable-next-line no-console
    console.log(`[boot] Prisma connected (connection_limit=${this.connectionLimit})`);
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
