import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class ZkPushService {
  private readonly logger = new Logger(ZkPushService.name);

  constructor(private readonly prisma: PrismaService) {}

  async handlePush(payload: { sn: string; query: Record<string, string>; body: string }) {
    try {
      return await this.prisma.zk_push_logs.create({
        data: {
          sn: payload.sn,
          raw_payload: payload as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (err: any) {
      this.logger.error(`Failed to log ZK push from ${payload.sn}: ${err.message}`);
      return null;
    }
  }

  async getLogs(sn?: string) {
    return this.prisma.zk_push_logs.findMany({
      where: sn ? { sn } : undefined,
      orderBy: { received_at: 'desc' },
      take: 200,
    });
  }

  async getDistinctDevices() {
    const logs = await this.prisma.zk_push_logs.findMany({
      select: { sn: true },
      distinct: ['sn'],
    });
    return logs.map((l) => l.sn);
  }
}
