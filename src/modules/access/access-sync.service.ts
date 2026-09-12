import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { TILES_MANIFEST } from './tiles.manifest';
import { isPendingMigrationError } from '../../utils/pending-migration.util';

/**
 * Projects TILES_MANIFEST into access_tiles so pack/grant FKs resolve.
 * The live catalog is served from memory — this is not a read path.
 */
@Injectable()
export class AccessSyncService implements OnModuleInit {
  private readonly logger = new Logger(AccessSyncService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.sync();
  }

  async sync() {
    const started = Date.now();
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

    // Boot must survive the window between this code deploying and its
    // migration being applied to the shared DB (CLAUDE.md rule 11). A tile
    // with no projected actions simply behaves as it did before
    // sub-permissions existed.
    let actionCount = 0;
    try {
      actionCount = await this.syncActions();
    } catch (err) {
      if (!isPendingMigrationError(err)) throw err;
      this.logger.warn(
        'access_tile_actions is not migrated yet - tile sub-permissions are inert. ' +
          'Run `prisma migrate deploy` to activate them.',
      );
    }

    this.logger.log(
      `Projected ${TILES_MANIFEST.length} access tiles and ${actionCount} sub-permissions ` +
        `for FKs in ${Date.now() - started}ms` +
        (deactivated.count ? `, deactivated ${deactivated.count} stale tile(s)` : ''),
    );
  }

  /**
   * Projects each tile's `actions` into access_tile_actions.
   *
   * Stale rows are deactivated rather than deleted: deleting would cascade
   * away every pack and user grant pointing at them, so renaming an action in
   * the manifest would silently revoke it for everyone. Deactivated rows stop
   * resolving but keep the grant history intact.
   */
  private async syncActions(): Promise<number> {
    const rows = TILES_MANIFEST.flatMap((tile) =>
      (tile.actions ?? []).map((action, i) => ({
        tile_id: tile.id,
        action_id: action.id,
        label: action.label,
        description: action.description ?? null,
        is_default: action.default ?? false,
        sort_order: i,
      })),
    );

    if (rows.length === 0) {
      await this.prisma.access_tile_actions.updateMany({
        where: { is_active: true },
        data: { is_active: false },
      });
      return 0;
    }

    const values = rows.map(
      (r) =>
        Prisma.sql`(${r.tile_id}, ${r.action_id}, ${r.label}, ${r.description}, ${r.is_default}, ${r.sort_order}, true)`,
    );

    await this.prisma.$executeRaw`
      INSERT INTO "access_tile_actions" ("tile_id", "action_id", "label", "description", "is_default", "sort_order", "is_active")
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("tile_id", "action_id") DO UPDATE SET
        "label" = EXCLUDED."label",
        "description" = EXCLUDED."description",
        "is_default" = EXCLUDED."is_default",
        "sort_order" = EXCLUDED."sort_order",
        "is_active" = true
    `;

    await this.prisma.$executeRaw`
      UPDATE "access_tile_actions" SET "is_active" = false
      WHERE "is_active" = true
        AND ("tile_id", "action_id") NOT IN (${Prisma.join(
          rows.map((r) => Prisma.sql`(${r.tile_id}, ${r.action_id})`),
        )})
    `;

    return rows.length;
  }
}
