import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient, Prisma } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: [
        { emit: 'event', level: 'query' },
        { emit: 'stdout', level: 'warn' },
        { emit: 'stdout', level: 'error' },
      ],
    });
  }

  async onModuleInit() {
    await this.$connect();

    // Log slow queries (>200ms) in all environments so bottlenecks are visible
    (this as any).$on('query', (e: Prisma.QueryEvent) => {
      if (e.duration > 200) {
        this.logger.warn(`Slow query (${e.duration}ms): ${e.query}`);
      }
    });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
