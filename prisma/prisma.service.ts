import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient, Prisma } from '@prisma/client';

function getOptimizedDatabaseUrl(): string | undefined {
  const raw = process.env.DATABASE_URL;
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    const limit = url.searchParams.get('connection_limit');
    // If connection_limit is missing or set to a low value (e.g. 1 or 2),
    // raise it to 10 so concurrent dashboard and page requests don't queue up and time out.
    if (!limit || Number(limit) < 10) {
      url.searchParams.set('connection_limit', '10');
    }
    // Fail fast when the pool is saturated. A 30s wait held HTTP sockets open
    // until clients aborted (nginx/Railway 499), which made outages worse.
    if (!url.searchParams.has('pool_timeout')) {
      url.searchParams.set('pool_timeout', '10');
    }
    if (!url.searchParams.has('connect_timeout')) {
      url.searchParams.set('connect_timeout', '5');
    }
    return url.toString();
  } catch {
    return raw;
  }
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const optimizedUrl = getOptimizedDatabaseUrl();
    super({
      ...(optimizedUrl ? { datasources: { db: { url: optimizedUrl } } } : {}),
      log: [
        { emit: 'stdout', level: 'warn' },
        { emit: 'stdout', level: 'error' },
      ],
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
