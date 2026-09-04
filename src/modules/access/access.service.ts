import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { computeEffectiveAccess, type EffectiveTile } from './access.effective';
import { CreateAccessPackDto, SetUserAccessDto, UpdateAccessPackDto } from './dto/access.dto';

@Injectable()
export class AccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async getCatalog() {
    const tiles = await this.prisma.access_tiles.findMany({
      where: { is_active: true },
      orderBy: [{ module: 'asc' }, { sort_order: 'asc' }],
      include: {
        capabilities: {
          include: { permission: { select: { key: true } } },
        },
      },
    });

    const byModule = new Map<string, typeof tiles>();
    for (const tile of tiles) {
      const list = byModule.get(tile.module) ?? [];
      list.push(tile);
      byModule.set(tile.module, list);
    }

    return {
      modules: [...byModule.entries()].map(([id, moduleTiles]) => ({
        id,
        tiles: moduleTiles.map((t) => ({
          id: t.id,
          module: t.module,
          label: t.label,
          description: t.description,
          href: t.href,
          group: t.group,
          sort_order: t.sort_order,
          capabilities: t.capabilities.map((c) => c.permission.key),
        })),
      })),
    };
  }

  async resolveEffective(userId: string, role: StaffRole) {
    const [allPerms, activeTiles, rolePerms, packRows, grants, userPerms] = await Promise.all([
      this.prisma.permissions.findMany({ select: { key: true } }),
      this.loadActiveTiles(),
      this.prisma.role_permissions.findMany({
        where: { role },
        include: { permissions: { select: { key: true } } },
      }),
      this.prisma.user_access_packs.findMany({
        where: { user_id: userId },
        include: { pack: { include: { tiles: { select: { tile_id: true } } } } },
      }),
      this.prisma.user_tile_grants.findMany({
        where: { user_id: userId },
        select: { tile_id: true, allow: true },
      }),
      this.prisma.user_permissions.findMany({
        where: { user_id: userId },
        include: { permissions: { select: { key: true } } },
      }),
    ]);

    return computeEffectiveAccess({
      role,
      allPermissionKeys: allPerms.map((p) => p.key),
      activeTiles,
      roleKeys: rolePerms.map((rp) => rp.permissions.key),
      packTileIds: packRows.flatMap((row) => row.pack.tiles.map((t) => t.tile_id)),
      allowTileIds: grants.filter((g) => g.allow).map((g) => g.tile_id),
      denyTileIds: grants.filter((g) => !g.allow).map((g) => g.tile_id),
      userPerms: userPerms.map((up) => ({ key: up.permissions.key, granted: up.granted })),
    });
  }

  async getUserAccess(userId: string) {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { id: true, username: true, role: true },
    });
    if (!user) throw new NotFoundException(`User ${userId} not found`);

    const [packs, assigned, grants, rolePerms, activeTiles] = await Promise.all([
      this.prisma.access_packs.findMany({
        orderBy: { name: 'asc' },
        include: { tiles: { select: { tile_id: true } } },
      }),
      this.prisma.user_access_packs.findMany({
        where: { user_id: userId },
        include: { pack: { select: { id: true, name: true } } },
      }),
      this.prisma.user_tile_grants.findMany({
        where: { user_id: userId },
        select: { tile_id: true, allow: true, note: true, granted_at: true },
      }),
      this.prisma.role_permissions.findMany({
        where: { role: user.role },
        include: { permissions: { select: { key: true } } },
      }),
      this.loadActiveTiles(),
    ]);

    const roleKeySet = new Set(rolePerms.map((rp) => rp.permissions.key));
    const roleTileIds = activeTiles
      .filter((t) => t.capabilities.every((c) => roleKeySet.has(c)))
      .map((t) => t.id);

    return {
      userId: user.id,
      username: user.username,
      role: user.role,
      roleTileIds,
      packIds: assigned.map((a) => a.pack_id),
      assignedPacks: assigned.map((a) => ({ id: a.pack.id, name: a.pack.name })),
      allPacks: packs.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        is_system: p.is_system,
        tileIds: p.tiles.map((t) => t.tile_id),
      })),
      grants: grants.map((g) => ({
        tileId: g.tile_id,
        allow: g.allow,
        note: g.note,
        grantedAt: g.granted_at,
      })),
    };
  }

  async setUserAccess(userId: string, dto: SetUserAccessDto, actorId: string, actorLabel?: string) {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { id: true, username: true },
    });
    if (!user) throw new NotFoundException(`User ${userId} not found`);

    const packIds = [...new Set(dto.packIds ?? [])];
    const grants = dto.tileGrants ?? [];
    const grantTileIds = grants.map((g) => g.tileId);

    if (packIds.length > 0) {
      const found = await this.prisma.access_packs.findMany({
        where: { id: { in: packIds } },
        select: { id: true },
      });
      if (found.length !== packIds.length) {
        throw new BadRequestException('One or more access packs do not exist');
      }
    }
    if (grantTileIds.length > 0) {
      const found = await this.prisma.access_tiles.findMany({
        where: { id: { in: grantTileIds } },
        select: { id: true },
      });
      if (found.length !== grantTileIds.length) {
        throw new BadRequestException('One or more tiles do not exist');
      }
    }

    const existingPacks = await this.prisma.user_access_packs.findMany({
      where: { user_id: userId },
      select: { pack_id: true },
    });
    const existingGrants = await this.prisma.user_tile_grants.findMany({
      where: { user_id: userId },
      select: { tile_id: true, allow: true },
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.user_access_packs.deleteMany({
        where: { user_id: userId, pack_id: { notIn: packIds } },
      });
      if (packIds.length > 0) {
        await tx.user_access_packs.createMany({
          data: packIds.map((pack_id) => ({
            user_id: userId,
            pack_id,
            assigned_by: actorId,
          })),
          skipDuplicates: true,
        });
      }

      await tx.user_tile_grants.deleteMany({
        where: { user_id: userId, tile_id: { notIn: grantTileIds } },
      });
      for (const grant of grants) {
        await tx.user_tile_grants.upsert({
          where: { user_id_tile_id: { user_id: userId, tile_id: grant.tileId } },
          update: {
            allow: grant.allow,
            granted_by: actorId,
            granted_at: new Date(),
            note: grant.note ?? null,
          },
          create: {
            user_id: userId,
            tile_id: grant.tileId,
            allow: grant.allow,
            granted_by: actorId,
            note: grant.note ?? null,
          },
        });
      }
    });

    const beforePacks = existingPacks.map((p) => p.pack_id).sort().join(',');
    const afterPacks = [...packIds].sort().join(',');
    const changedBy = actorLabel ?? actorId;
    if (beforePacks !== afterPacks) {
      await this.auditLogs.log({
        entity_type: 'PERMISSION',
        entity_id: userId,
        action: 'UPDATED',
        section: 'system',
        field: 'access_packs',
        old_value: beforePacks || null,
        new_value: afterPacks || null,
        changed_by: changedBy,
        note: `Access packs for user ${user.username} (#${userId}): [${beforePacks || '�'}] ? [${afterPacks || '�'}].`,
      });
    }

    const beforeGrantMap = new Map(existingGrants.map((g) => [g.tile_id, g.allow]));
    const afterGrantMap = new Map(grants.map((g) => [g.tileId, g.allow]));
    const allGrantIds = new Set([...beforeGrantMap.keys(), ...afterGrantMap.keys()]);
    for (const tileId of allGrantIds) {
      const before = beforeGrantMap.get(tileId);
      const after = afterGrantMap.get(tileId);
      if (before === after) continue;
      await this.auditLogs.log({
        entity_type: 'PERMISSION',
        entity_id: `${userId}:${tileId}`,
        action: after === undefined ? 'DELETED' : before === undefined ? 'CREATED' : 'UPDATED',
        section: 'system',
        field: 'user_tile_grant',
        old_value: before === undefined ? null : String(before),
        new_value: after === undefined ? null : String(after),
        changed_by: changedBy,
        note: `Tile grant "${tileId}" for user ${user.username} (#${userId}): ` +
          (after === undefined
            ? `removed (was allow=${before})`
            : before === undefined
              ? `set allow=${after}`
              : `allow ${before} ? ${after}`) +
          '.',
      });
    }

    return this.getUserAccess(userId);
  }

  async listPacks() {
    return this.prisma.access_packs.findMany({
      orderBy: [{ is_system: 'desc' }, { name: 'asc' }],
      include: { tiles: { select: { tile_id: true } } },
    });
  }

  async createPack(dto: CreateAccessPackDto, actorLabel?: string) {
    const tileIds = [...new Set(dto.tileIds ?? [])];
    await this.assertTilesExist(tileIds);
    const pack = await this.prisma.access_packs.create({
      data: {
        name: dto.name.trim(),
        description: dto.description?.trim() || null,
        is_system: false,
        tiles: tileIds.length
          ? { create: tileIds.map((tile_id) => ({ tile_id })) }
          : undefined,
      },
      include: { tiles: { select: { tile_id: true } } },
    });
    await this.auditLogs.log({
      entity_type: 'PERMISSION',
      entity_id: pack.id,
      action: 'CREATED',
      section: 'system',
      field: 'access_pack',
      new_value: pack.name,
      changed_by: actorLabel ?? 'system',
      note: `Created access pack "${pack.name}" with ${tileIds.length} tile(s).`,
    });
    return pack;
  }

  async updatePack(id: string, dto: UpdateAccessPackDto, actorLabel?: string) {
    const existing = await this.prisma.access_packs.findUnique({
      where: { id },
      include: { tiles: { select: { tile_id: true } } },
    });
    if (!existing) throw new NotFoundException(`Access pack ${id} not found`);

    const tileIds = dto.tileIds !== undefined ? [...new Set(dto.tileIds)] : undefined;
    if (tileIds) await this.assertTilesExist(tileIds);

    const pack = await this.prisma.$transaction(async (tx) => {
      if (tileIds) {
        await tx.access_pack_tiles.deleteMany({
          where: { pack_id: id, tile_id: { notIn: tileIds } },
        });
        if (tileIds.length > 0) {
          await tx.access_pack_tiles.createMany({
            data: tileIds.map((tile_id) => ({ pack_id: id, tile_id })),
            skipDuplicates: true,
          });
        }
      }
      return tx.access_packs.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.description !== undefined ? { description: dto.description?.trim() || null } : {}),
        },
        include: { tiles: { select: { tile_id: true } } },
      });
    });

    await this.auditLogs.log({
      entity_type: 'PERMISSION',
      entity_id: id,
      action: 'UPDATED',
      section: 'system',
      field: 'access_pack',
      old_value: existing.name,
      new_value: pack.name,
      changed_by: actorLabel ?? 'system',
      note: `Updated access pack "${pack.name}".`,
    });
    return pack;
  }

  async deletePack(id: string, actorLabel?: string) {
    const existing = await this.prisma.access_packs.findUnique({
      where: { id },
      select: { id: true, name: true, is_system: true },
    });
    if (!existing) throw new NotFoundException(`Access pack ${id} not found`);
    if (existing.is_system) {
      throw new BadRequestException('System access packs cannot be deleted');
    }
    await this.prisma.access_packs.delete({ where: { id } });
    await this.auditLogs.log({
      entity_type: 'PERMISSION',
      entity_id: id,
      action: 'DELETED',
      section: 'system',
      field: 'access_pack',
      old_value: existing.name,
      changed_by: actorLabel ?? 'system',
      note: `Deleted access pack "${existing.name}".`,
    });
    return { deleted: true };
  }

  private async loadActiveTiles(): Promise<EffectiveTile[]> {
    const rows = await this.prisma.access_tiles.findMany({
      where: { is_active: true },
      orderBy: { sort_order: 'asc' },
      include: {
        capabilities: { include: { permission: { select: { key: true } } } },
      },
    });
    return rows.map((t) => ({
      id: t.id,
      capabilities: t.capabilities.map((c) => c.permission.key),
    }));
  }

  private async assertTilesExist(tileIds: string[]) {
    if (tileIds.length === 0) return;
    const found = await this.prisma.access_tiles.findMany({
      where: { id: { in: tileIds } },
      select: { id: true },
    });
    if (found.length !== tileIds.length) {
      throw new BadRequestException('One or more tiles do not exist');
    }
  }
}
