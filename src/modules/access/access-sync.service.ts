import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { TILES_MANIFEST } from './tiles.manifest';

@Injectable()
export class AccessSyncService implements OnModuleInit {
  private readonly logger = new Logger(AccessSyncService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.sync();
  }

  async sync() {
    const started = Date.now();
    this.logger.log(`Syncing ${TILES_MANIFEST.length} access tiles…`);

    const keys = [...new Set(TILES_MANIFEST.flatMap((t) => t.capabilities))];
    const permissions = await this.prisma.permissions.findMany({
      where: { key: { in: keys } },
      select: { id: true, key: true },
    });
    const permByKey = new Map(permissions.map((p) => [p.key, p.id]));
    const missing = keys.filter((k) => !permByKey.has(k));
    if (missing.length > 0) {
      throw new Error(
        `Access tile manifest references permission keys that do not exist: ${missing.join(', ')}. ` +
          'Add them to scripts/seed-permissions.ts (and run the seed) before booting.',
      );
    }

    const manifestIds = TILES_MANIFEST.map((t) => t.id);
    const tileRows = TILES_MANIFEST.map(
      (tile, i) =>
        Prisma.sql`(${tile.id}, ${tile.module}, ${tile.label}, ${tile.description}, ${tile.href}, ${tile.group ?? null}, ${i}, true)`,
    );

    await this.prisma.$executeRaw`
      INSERT INTO "access_tiles" ("id", "module", "label", "description", "href", "group", "sort_order", "is_active")
      VALUES ${Prisma.join(tileRows)}
      ON CONFLICT ("id") DO UPDATE SET
        "module" = EXCLUDED."module",
        "label" = EXCLUDED."label",
        "description" = EXCLUDED."description",
        "href" = EXCLUDED."href",
        "group" = EXCLUDED."group",
        "sort_order" = EXCLUDED."sort_order",
        "is_active" = true
    `;

    const capabilityRows = TILES_MANIFEST.flatMap((tile) =>
      tile.capabilities.map((key) => ({
        tile_id: tile.id,
        permission_id: permByKey.get(key)!,
      })),
    );

    await this.prisma.access_tile_capabilities.deleteMany({
      where: { tile_id: { in: manifestIds } },
    });
    if (capabilityRows.length > 0) {
      await this.prisma.access_tile_capabilities.createMany({
        data: capabilityRows,
      });
    }

    const deactivated = await this.prisma.access_tiles.updateMany({
      where: { id: { notIn: manifestIds }, is_active: true },
      data: { is_active: false },
    });

    this.logger.log(
      `Synced ${TILES_MANIFEST.length} access tiles in ${Date.now() - started}ms` +
        (deactivated.count ? `, deactivated ${deactivated.count} stale` : ''),
    );
  }
}
