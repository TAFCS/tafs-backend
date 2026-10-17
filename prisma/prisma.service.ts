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
    // Respect an explicit limit (scripts use 1–3). Only default when unset —
    // never raise a low value to 10 (that exhausted DO max_connections).
    if (!existing) {
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
  private readonly connectionLimit: number;

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
    this.logger.log(
      `Prisma $connect (timeout ${CONNECT_MS}ms, connection_limit=${this.connectionLimit})…`,
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
    this.logger.log(`Prisma connected (connection_limit=${this.connectionLimit})`);
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
