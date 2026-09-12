import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { computeEffectiveAccess } from './access.effective';
import { CreateAccessPackDto, SetUserAccessDto, UpdateAccessPackDto } from './dto/access.dto';
import { ScopeService } from '../../common/scope/scope.service';
import { EMPTY_SCOPE, type UserScope } from '../../common/scope/scope.types';
import {
  actionKey,
  catalogFromManifest,
  MANIFEST_ACTION_KEYS,
  MANIFEST_EFFECTIVE_TILES,
  MANIFEST_TILE_IDS,
} from './tiles.manifest';
import { readUntilMigrated } from '../../utils/pending-migration.util';

@Injectable()
export class AccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly scopeService: ScopeService,
  ) {}

  /**
   * Everything a scope picker can offer. Small, stable reference data -- the
   * panel fetches it once and filters client-side.
   */
  async getScopeOptions() {
    const [campuses, segments, classes, sections, departments, staffCategories] =
      await Promise.all([
        this.prisma.campuses.findMany({
          where: { is_active: true },
          select: { id: true, campus_name: true, campus_code: true },
          orderBy: { campus_name: 'asc' },
        }),
        this.prisma.segments.findMany({
          select: { id: true, name: true, code: true },
          orderBy: { display_order: 'asc' },
        }),
        this.prisma.classes.findMany({
          select: { id: true, description: true, class_code: true, segment_id: true },
          orderBy: { id: 'asc' },
        }),
        this.prisma.sections.findMany({
          select: { id: true, description: true },
          orderBy: { id: 'asc' },
        }),
        this.prisma.departments.findMany({
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
        this.prisma.staff_categories.findMany({
          select: { id: true, name: true, code: true, department_id: true },
          orderBy: { name: 'asc' },
        }),
      ]);

    return {
      campuses: campuses.map((c) => ({ id: c.id, label: c.campus_name, code: c.campus_code })),
      segments: segments.map((s) => ({ id: s.id, label: s.name, code: s.code })),
      classes: classes.map((c) => ({
        id: c.id,
        label: c.description,
        code: c.class_code,
        segmentId: c.segment_id,
      })),
      sections: sections.map((s) => ({ id: s.id, label: s.description })),
      departments: departments.map((d) => ({ id: d.id, label: d.name })),
      staffCategories: staffCategories.map((c) => ({
        id: c.id,
        label: c.name,
        code: c.code,
        departmentId: c.department_id,
      })),
    };
  }

  async getCatalog() {
    return catalogFromManifest();
  }

  async resolveEffective(userId: string, role: StaffRole) {
    const [allPerms, rolePerms, packRows, grants, userPerms, packActions, userActionGrants] =
      await Promise.all([
        this.prisma.permissions.findMany({ select: { key: true } }),
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
        this.readPackActions(userId),
        this.readUserActionGrants(userId),
      ]);

    return computeEffectiveAccess({
      role,
      allPermissionKeys: allPerms.map((p) => p.key),
      activeTiles: MANIFEST_EFFECTIVE_TILES,
      roleKeys: rolePerms.map((rp) => rp.permissions.key),
      packTileIds: packRows.flatMap((row) => row.pack.tiles.map((t) => t.tile_id)),
      allowTileIds: grants.filter((g) => g.allow).map((g) => g.tile_id),
      denyTileIds: grants.filter((g) => !g.allow).map((g) => g.tile_id),
      userPerms: userPerms.map((up) => ({ key: up.permissions.key, granted: up.granted })),
      packActions,
      userActionGrants,
    });
  }

  /**
   * Sub-permission reads are guarded until their migration lands on the shared
   * DB (CLAUDE.md rule 11). Empty means "no sub-permissions", which is exactly
   * how tiles behaved before actions existed.
   */
  private async readPackActions(userId: string) {
    return readUntilMigrated(
      async () => {
        const rows = await this.prisma.access_pack_tile_actions.findMany({
          where: { pack: { user_packs: { some: { user_id: userId } } } },
          select: { tile_id: true, action_id: true },
        });
        return rows.map((r) => ({ tileId: r.tile_id, actionId: r.action_id }));
      },
      [] as { tileId: string; actionId: string }[],
    );
  }

  private async readUserActionGrants(userId: string) {
    return readUntilMigrated(
      async () => {
        const rows = await this.prisma.user_tile_action_grants.findMany({
          where: { user_id: userId },
          select: { tile_id: true, action_id: true, allow: true },
        });
        return rows.map((r) => ({ tileId: r.tile_id, actionId: r.action_id, allow: r.allow }));
      },
      [] as { tileId: string; actionId: string; allow: boolean }[],
    );
  }

  private assertActionsExist(refs: { tileId: string; actionId: string }[]) {
    const unknown = refs.filter((r) => !MANIFEST_ACTION_KEYS.has(actionKey(r.tileId, r.actionId)));
    if (unknown.length > 0) {
      throw new BadRequestException(
        `Unknown tile sub-permission(s): ${unknown
          .map((r) => actionKey(r.tileId, r.actionId))
          .join(', ')}`,
      );
    }
  }

  async getUserAccess(userId: string) {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { id: true, username: true, role: true },
    });
    if (!user) throw new NotFoundException(`User ${userId} not found`);

    const [packs, assigned, grants, rolePerms, actionGrants] = await Promise.all([
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
      readUntilMigrated(
        () =>
          this.prisma.user_tile_action_grants.findMany({
            where: { user_id: userId },
            select: { tile_id: true, action_id: true, allow: true, note: true, granted_at: true },
          }),
        [] as {
          tile_id: string;
          action_id: string;
          allow: boolean;
          note: string | null;
          granted_at: Date;
        }[],
      ),
    ]);

    const scope = await this.scopeService.resolve(userId);

    const packActionRows = await readUntilMigrated(
      () =>
        this.prisma.access_pack_tile_actions.findMany({
          select: { pack_id: true, tile_id: true, action_id: true },
        }),
      [] as { pack_id: string; tile_id: string; action_id: string }[],
    );
    const actionsByPack = new Map<string, { tileId: string; actionId: string }[]>();
    for (const row of packActionRows) {
      actionsByPack.set(row.pack_id, [
        ...(actionsByPack.get(row.pack_id) ?? []),
        { tileId: row.tile_id, actionId: row.action_id },
      ]);
    }

    const roleKeySet = new Set(rolePerms.map((rp) => rp.permissions.key));
    const roleTileIds = MANIFEST_EFFECTIVE_TILES
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
        tileActions: actionsByPack.get(p.id) ?? [],
      })),
      grants: grants.map((g) => ({
        tileId: g.tile_id,
        allow: g.allow,
        note: g.note,
        grantedAt: g.granted_at,
      })),
      actionGrants: actionGrants.map((g) => ({
        tileId: g.tile_id,
        actionId: g.action_id,
        allow: g.allow,
        note: g.note,
        grantedAt: g.granted_at,
      })),
      scope,
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
    await this.assertTilesExist(grantTileIds);

    const actionGrants = dto.tileActionGrants ?? [];
    this.assertActionsExist(actionGrants);

    const existingPacks = await this.prisma.user_access_packs.findMany({
      where: { user_id: userId },
      select: { pack_id: true },
    });
    const existingGrants = await this.prisma.user_tile_grants.findMany({
      where: { user_id: userId },
      select: { tile_id: true, allow: true },
    });
    const existingActionGrants = await readUntilMigrated(
      () =>
        this.prisma.user_tile_action_grants.findMany({
          where: { user_id: userId },
          select: { tile_id: true, action_id: true, allow: true },
        }),
      [] as { tile_id: string; action_id: string; allow: boolean }[],
    );

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

      // Only touch sub-permissions when the caller actually sent them, so a
      // client built before actions existed cannot silently wipe them.
      if (dto.tileActionGrants !== undefined) {
        await tx.user_tile_action_grants.deleteMany({ where: { user_id: userId } });
        if (actionGrants.length > 0) {
          await tx.user_tile_action_grants.createMany({
            data: actionGrants.map((g) => ({
              user_id: userId,
              tile_id: g.tileId,
              action_id: g.actionId,
              allow: g.allow,
              granted_by: actorId,
              note: g.note ?? null,
            })),
            skipDuplicates: true,
          });
        }
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

    if (dto.scope !== undefined) {
      const previous = await this.scopeService.resolve(userId);
      const next = await this.scopeService.setScope(userId, dto.scope);
      const summarise = (sc: UserScope) =>
        (Object.keys(EMPTY_SCOPE) as (keyof UserScope)[])
          .map((k) => `${k}=[${[...sc[k]].sort((a, b) => a - b).join(',')}]`)
          .join(' ');
      const before = summarise(previous);
      const after = summarise(next);
      if (before !== after) {
        await this.auditLogs.log({
          entity_type: 'PERMISSION',
          entity_id: userId,
          action: 'UPDATED',
          section: 'system',
          field: 'user_scope',
          old_value: before,
          new_value: after,
          changed_by: changedBy,
          note: `Data scope for user ${user.username} (#${userId}): ${before} -> ${after}.`,
        });
      }
    }

    if (dto.tileActionGrants !== undefined) {
      const before = new Map(
        existingActionGrants.map((g) => [actionKey(g.tile_id, g.action_id), g.allow]),
      );
      const after = new Map(actionGrants.map((g) => [actionKey(g.tileId, g.actionId), g.allow]));
      for (const k of new Set([...before.keys(), ...after.keys()])) {
        const wasAllowed = before.get(k);
        const isAllowed = after.get(k);
        if (wasAllowed === isAllowed) continue;
        await this.auditLogs.log({
          entity_type: 'PERMISSION',
          entity_id: `${userId}:${k}`,
          action: isAllowed === undefined ? 'DELETED' : wasAllowed === undefined ? 'CREATED' : 'UPDATED',
          section: 'system',
          field: 'user_tile_action_grant',
          old_value: wasAllowed === undefined ? null : String(wasAllowed),
          new_value: isAllowed === undefined ? null : String(isAllowed),
          changed_by: changedBy,
          note:
            `Sub-permission "${k}" for user ${user.username} (#${userId}): ` +
            (isAllowed === undefined
              ? `removed (was allow=${wasAllowed})`
              : wasAllowed === undefined
                ? `set allow=${isAllowed}`
                : `allow ${wasAllowed} -> ${isAllowed}`) +
            '.',
        });
      }
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
    const tileActions = dto.tileActions ?? [];
    this.assertActionsExist(tileActions);

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
    await this.writePackActions(pack.id, tileActions);
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

    const tileActions = dto.tileActions;
    if (tileActions) this.assertActionsExist(tileActions);

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

    if (tileActions) await this.writePackActions(id, tileActions);

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

  /**
   * Replaces a pack's sub-permissions. Guarded until the migration lands, so a
   * pack edit on an unmigrated deploy still saves its tiles rather than 500ing.
   */
  private async writePackActions(
    packId: string,
    tileActions: { tileId: string; actionId: string }[],
  ) {
    await readUntilMigrated(
      async () => {
        await this.prisma.$transaction(async (tx) => {
          await tx.access_pack_tile_actions.deleteMany({ where: { pack_id: packId } });
          if (tileActions.length > 0) {
            await tx.access_pack_tile_actions.createMany({
              data: tileActions.map((a) => ({
                pack_id: packId,
                tile_id: a.tileId,
                action_id: a.actionId,
              })),
              skipDuplicates: true,
            });
          }
        });
        return true;
      },
      false,
    );
  }

  private async assertTilesExist(tileIds: string[]) {
    if (tileIds.length === 0) return;
    if (tileIds.some((id) => !MANIFEST_TILE_IDS.has(id))) {
      throw new BadRequestException('One or more tiles do not exist');
    }
  }
}
