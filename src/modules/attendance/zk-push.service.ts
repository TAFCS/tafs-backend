import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { classifyDevice, ZK_DEVICES } from './zk-device-health.util';

/** A server→device command waiting for the device's next GET /iclock/getrequest. */
export interface PendingDeviceCommand {
  id: number;
  command: string;
  queuedAt: Date;
}

@Injectable()
export class ZkPushService {
  private readonly logger = new Logger(ZkPushService.name);

  /**
   * TRIAL — deliberately in memory, not a table, so this ships with no migration
   * (CLAUDE.md rule 11). At most ONE pending command per device: a newer one
   * replaces an older one that was never picked up, so a device that stays
   * offline for days gets one command on reconnect, not a pile. A restart drops
   * whatever is queued, which is acceptable while we find out whether the
   * firmware honours the command at all.
   */
  private readonly pendingCommands = new Map<string, PendingDeviceCommand>();
  private nextCommandId = Math.floor(Date.now() / 1000) % 1_000_000;

  /**
   * Last time each device hit any /iclock/* route, including the ~60s
   * getrequest poll that is not written to zk_push_logs. In memory on purpose
   * (no per-poll DB write); after a restart getDeviceHealth falls back to
   * zk_push_logs until the next poll repopulates it.
   */
  private readonly lastContact = new Map<string, Date>();

  constructor(private readonly prisma: PrismaService) {}

  touchDevice(sn: string) {
    this.lastContact.set(sn, new Date());
  }

  /**
   * Heartbeat per known device. `campusCodes` limits to specific campus(es) (non
   * super-admin users); omit for all.
   */
  async getDeviceHealth(campusCodes?: string[] | string | null, now = new Date()) {
    const codes = Array.isArray(campusCodes)
      ? campusCodes
      : campusCodes
      ? [campusCodes]
      : null;
    const sns = Object.keys(ZK_DEVICES).filter(
      (sn) => !codes || codes.includes(ZK_DEVICES[sn].campusCode),
    );
    const rows = sns.length
      ? await this.prisma.zk_push_logs.groupBy({
          by: ['sn'],
          where: { sn: { in: sns } },
          _max: { received_at: true },
        })
      : [];
    const lastPush = new Map(rows.map((r) => [r.sn, r._max.received_at]));

    return sns.map((sn) => {
      const info = ZK_DEVICES[sn];
      const candidates = [this.lastContact.get(sn), lastPush.get(sn)].filter(
        (d): d is Date => !!d,
      );
      const last = candidates.length
        ? new Date(Math.max(...candidates.map((d) => d.getTime())))
        : null;
      return {
        sn,
        name: info.name,
        campus_code: info.campusCode,
        last_contact_at: last ? last.toISOString() : null,
        ...classifyDevice(now, last, info.activeOnSaturday),
      };
    });
  }

  queueDeviceCommand(sn: string, command: string): PendingDeviceCommand {
    const pending = { id: this.nextCommandId++, command, queuedAt: new Date() };
    const replaced = this.pendingCommands.get(sn);
    this.pendingCommands.set(sn, pending);
    this.logger.log(
      `Queued device command C:${pending.id} for SN=${sn}: ${command.replace(/\t/g, ' ')}` +
        (replaced ? ` (replaced unsent C:${replaced.id})` : ''),
    );
    return pending;
  }

  /** Removes and returns the device's pending command, if any. */
  takeDeviceCommand(sn: string): PendingDeviceCommand | undefined {
    const pending = this.pendingCommands.get(sn);
    if (pending) this.pendingCommands.delete(sn);
    return pending;
  }

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

  async getLogs(sn?: string, cursor?: number, limit = 50) {
    const logs = await this.prisma.zk_push_logs.findMany({
      where: {
        ...(sn ? { sn } : undefined),
        ...(cursor ? { id: { lt: cursor } } : undefined),
      },
      orderBy: { id: 'desc' },
      take: limit + 1,
    });
    const hasMore = logs.length > limit;
    const page = hasMore ? logs.slice(0, limit) : logs;
    return { logs: page, nextCursor: hasMore ? page[page.length - 1].id : null };
  }

  async getDistinctDevices() {
    const logs = await this.prisma.zk_push_logs.findMany({
      select: { sn: true },
      distinct: ['sn'],
    });
    return logs.map((l) => l.sn);
  }
}
