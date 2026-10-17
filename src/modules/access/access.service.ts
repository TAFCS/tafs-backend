import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogsService, type AuditLogParams } from '../audit-logs/audit-logs.service';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { computeEffectiveAccess } from './access.effective';
import { CreateAccessPackDto, SetUserAccessDto, UpdateAccessPackDto } from './dto/access.dto';
import { ScopeService } from '../../common/scope/scope.service';
import { EMPTY_SCOPE, type UserScope } from '../../common/scope/scope.types';
import { isSuperAdmin } from '../../common/auth/super-admin';
import {
  actionKey,
  catalogFromManifest,
  MANIFEST_ACTION_KEYS,
  MANIFEST_EFFECTIVE_TILES,
  MANIFEST_TILE_IDS,
} from './tiles.manifest';
import { readUntilMigrated } from '../../utils/pending-migration.util';
import { PEOPLE_ACCESS_TILE_ID } from '../users/user-field-tabs';

export type LiveStaffSession = {
  isActive: boolean;
  role: StaffRole;
  capabilityKeys: string[];
  actionIds: string[];
};

const LIVE_SESSION_TTL_MS = 30_000;


const TARGET_PROFILE_SELECT = {
  campus_id: true,
  segment_id: true,
  department_id: true,
  staff_category_id: true,
} as const;

type TargetProfile = {
  campus_id: number | null;
  segment_id: number | null;
  department_id: number | null;
  staff_category_id: number | null;
};

type EffectiveAccess = { capabilityKeys: string[]; tileIds: string[]; actionIds: string[] };

export type ProposedAccess = {
  packIds?: string[];
  grants?: { tileId: string; allow: boolean }[];
  actionGrants?: { tileId: string; actionId: string; allow: boolean }[];
  userPerms?: { key: string; granted: boolean }[];
};

/** Pack action rows grouped by pack, minus actions retired from the manifest. */
function groupLiveActions(rows: { pack_id: string; tile_id: string; action_id: string }[]) {
  const byPack = new Map<string, { tileId: string; actionId: string }[]>();
  for (const row of rows) {
    if (!MANIFEST_ACTION_KEYS.has(actionKey(row.tile_id, row.action_id))) continue;
    const list = byPack.get(row.pack_id) ?? [];
    list.push({ tileId: row.tile_id, actionId: row.action_id });
    byPack.set(row.pack_id, list);
  }
  return byPack;
}

@Injectable()
export class AccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly scopeService: ScopeService,
  ) {}

  /**
   * A scoped holder of People & Access only sees and manages users inside
   * their FULL scope -- campus, segment, department and staff category -- by
   * the same rule as the user list (UsersService.canSeeUser): the employee
   * profile's dimensions when there is one, else the legacy users.campus_id.
   * This used to check campus only, so a department-scoped viewer could read
   * the access of people the list hid from them (TAFSD-373).
   *
   * Throws NotFoundException, not Forbidden: a 403 would confirm a real user
   * exists outside the caller's scope and turn the route into an enumerator.
   */
  private assertCanManageUser(
    actingUser: IJwtStaffPayload,
    target: { campus_id: number | null; employee_profile: TargetProfile | null },
    userId: string,
  ) {
    if (this.scopeService.isExempt(actingUser)) return;
    const p = target.employee_profile;
    const visible = this.scopeService.canSeeEmployee(actingUser, {
      campus_id: p ? p.campus_id : target.campus_id,
      segment_id: p?.segment_id ?? null,
      department_id: p?.department_id ?? null,
      staff_category_id: p?.staff_category_id ?? null,
    });
    if (!visible) throw new NotFoundException(`User ${userId} not found`);
  }

  /**
   * Departments whose staff carry segments — in practice the teaching
   * department. Derived from the data rather than a name so a rename can't
   * break it: a segment restriction can only ever match staff in these.
   */
  private async segmentBearingDepartmentIds(): Promise<Set<number>> {
    const rows = await this.prisma.employee_profiles.findMany({
      where: { segment_id: { not: null }, department_id: { not: null } },
      select: { department_id: true },
      distinct: ['department_id'],
    });
    return new Set(rows.map((r) => r.department_id as number));
  }

  /**
   * Segments are academic: only teaching staff have one. A segment restriction
   * on a scope whose Departments exclude every segment-bearing department
   * would select no staff at all and silently hide the rest, so it is refused.
   * Departments on "All" (empty) always include them.
   */
  private async assertSegmentsFitDepartments(scope: Partial<UserScope>) {
    const segments = scope.segments ?? [];
    const departments = scope.departments ?? [];
    if (segments.length === 0 || departments.length === 0) return;
    const bearing = await this.segmentBearingDepartmentIds();
    if (departments.some((d) => bearing.has(d))) return;
    throw new BadRequestException(
      'Segments only apply to teaching staff. Add the teaching department (e.g. Academics) to Departments, ' +
        'or leave Segments on All.',
    );
  }

  /**
   * Staff categories belong to a department. A category whose department is
   * not among a restricted Departments list can never match anyone (the two
   * dimensions AND together), so it is refused rather than saved as a scope
   * that silently selects nothing. Departments on "All" (empty) take any
   * category.
   */
  private async assertStaffCategoriesFitDepartments(scope: Partial<UserScope>) {
    const categories = scope.staffCategories ?? [];
    const departments = scope.departments ?? [];
    if (categories.length === 0 || departments.length === 0) return;
    const rows = await this.prisma.staff_categories.findMany({
      where: { id: { in: [...new Set(categories)] } },
      select: { id: true, name: true, department_id: true },
    });
    const outside = rows.filter((r) => !departments.includes(r.department_id));
    if (outside.length === 0) return;
    throw new BadRequestException(
      `${outside.map((r) => r.name).join(', ')} ${outside.length === 1 ? 'is' : 'are'} not in the selected ` +
        'Departments. Add the department, or remove the category.',
    );
  }

  /**
   * Everything a scope picker can offer. Small, stable reference data -- the
   * panel fetches it once and filters client-side.
   */
  async getScopeOptions(actingUser?: IJwtStaffPayload) {
    const [campuses, segments, classes, sections, departments, staffCategories, segmentBearing] =
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
        this.segmentBearingDepartmentIds(),
      ]);

    // A non-super-admin can only grant scope inside their own, so offering the
    // rest of the school only lists campuses, classes and departments they have
    // no business with (TAFSD-373). Each restricted dimension is narrowed;
    // classes and staff categories also follow their parent dimension.
    const mine = actingUser ? this.scopeService.scopeOf(actingUser) : EMPTY_SCOPE;
    const within = <T extends { id: number }>(rows: T[], ids: number[]) =>
      ids.length === 0 ? rows : rows.filter((r) => ids.includes(r.id));
    const visibleClasses = within(classes, mine.classes).filter(
      (c) => mine.segments.length === 0 || (c.segment_id != null && mine.segments.includes(c.segment_id)),
    );
    const visibleCategories = within(staffCategories, mine.staffCategories).filter(
      (c) => mine.departments.length === 0 || mine.departments.includes(c.department_id),
    );

    return {
      campuses: within(campuses, mine.campuses).map((c) => ({ id: c.id, label: c.campus_name, code: c.campus_code })),
      segments: within(segments, mine.segments).map((s) => ({ id: s.id, label: s.name, code: s.code })),
      classes: visibleClasses.map((c) => ({
        id: c.id,
        label: c.description,
        code: c.class_code,
        segmentId: c.segment_id,
      })),
      sections: within(sections, mine.sections).map((s) => ({ id: s.id, label: s.description })),
      // hasSegments: this department's staff carry segments (the teaching
      // department) — the Scope tab only allows segments alongside one.
      departments: within(departments, mine.departments).map((d) => ({ id: d.id, label: d.name, hasSegments: segmentBearing.has(d.id) })),
      staffCategories: visibleCategories.map((c) => ({
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

  /**
   * The caller's account state and effective access, read live on every
   * request (TAFSD-308) instead of trusted from the 90-day token: revoking a
   * tile, pack, permission or role takes effect on the next API call, with no
   * re-login. A short in-memory cache absorbs the burst of requests a page load
   * makes; every write below that changes someone's access drops their entry.
   * Writes this service does not see (another instance, a raw SQL fix) are
   * bounded by the TTL.
   */
  private liveSessionCache = new Map<string, { session: LiveStaffSession; expires: number }>();

  async resolveLiveSession(userId: string): Promise<LiveStaffSession | null> {
    const now = Date.now();
    const cached = this.liveSessionCache.get(userId);
    if (cached && cached.expires > now) return cached.session;

    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { is_active: true, role: true },
    });
    if (!user) {
      this.liveSessionCache.delete(userId);
      return null;
    }
    const access = await this.resolveEffective(userId, user.role);
    const session: LiveStaffSession = {
      isActive: Boolean(user.is_active),
      role: user.role,
      capabilityKeys: access.capabilityKeys,
      actionIds: access.actionIds,
    };
    this.liveSessionCache.set(userId, { session, expires: now + LIVE_SESSION_TTL_MS });
    return session;
  }

  /** Drop one user's cached session, or everyone's (role or pack changes). */
  invalidateLiveSession(userId?: string) {
    if (userId) this.liveSessionCache.delete(userId);
    else this.liveSessionCache.clear();
  }

  async resolveEffective(userId: string, role: StaffRole) {
    return this.effectiveWith(userId, role);
  }

  /**
   * What a user would hold if `proposed` replaced the matching parts of their
   * stored access. `userId` null means a login that does not exist yet (no
   * packs, grants or overrides). Used to check a change before it is written.
   */
  async effectiveWith(userId: string | null, role: StaffRole, proposed: ProposedAccess = {}) {
    const none = <T,>(): Promise<T[]> => Promise.resolve([]);
    // Two-at-a-time, not Promise.all(7): a dashboard burst of N cold JWT
    // validates was opening ~N×7 connections and hit DO "too many clients".
    const allPerms = await this.prisma.permissions.findMany({ select: { key: true } });
    const rolePerms = await this.prisma.role_permissions.findMany({
      where: { role },
      include: { permissions: { select: { key: true } } },
    });
    const [packRows, grants] = await Promise.all([
      proposed.packIds !== undefined
        ? this.prisma.access_packs
            .findMany({
              where: { id: { in: proposed.packIds } },
              include: { tiles: { select: { tile_id: true } } },
            })
            .then((packs) => packs.map((pack) => ({ pack })))
        : userId
          ? this.prisma.user_access_packs.findMany({
              where: { user_id: userId },
              include: { pack: { include: { tiles: { select: { tile_id: true } } } } },
            })
          : none<{ pack: { tiles: { tile_id: string }[] } }>(),
      proposed.grants !== undefined
        ? Promise.resolve(proposed.grants.map((g) => ({ tile_id: g.tileId, allow: g.allow })))
        : userId
          ? this.prisma.user_tile_grants.findMany({
              where: { user_id: userId },
              select: { tile_id: true, allow: true },
            })
          : none<{ tile_id: string; allow: boolean }>(),
    ]);
    const [userPerms, packActions] = await Promise.all([
      proposed.userPerms !== undefined
        ? Promise.resolve(proposed.userPerms.map((p) => ({ permissions: { key: p.key }, granted: p.granted })))
        : userId
          ? this.prisma.user_permissions.findMany({
              where: { user_id: userId },
              include: { permissions: { select: { key: true } } },
            })
          : none<{ permissions: { key: string }; granted: boolean }>(),
      proposed.packIds !== undefined
        ? this.readActionsOfPacks(proposed.packIds)
        : userId
          ? this.readPackActions(userId)
          : none<{ tileId: string; actionId: string }>(),
    ]);
    const userActionGrants =
      proposed.actionGrants !== undefined
        ? proposed.actionGrants
        : userId
          ? await this.readUserActionGrants(userId)
          : [];

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

  private async readActionsOfPacks(packIds: string[]) {
    if (packIds.length === 0) return [];
    return readUntilMigrated(
      async () => {
        const rows = await this.prisma.access_pack_tile_actions.findMany({
          where: { pack_id: { in: packIds } },
          select: { tile_id: true, action_id: true },
        });
        return rows.map((r) => ({ tileId: r.tile_id, actionId: r.action_id }));
      },
      [] as { tileId: string; actionId: string }[],
    );
  }

  // ─── Guards for anyone who is not a SUPER_ADMIN (TAFSD-365) ──────────────
  // The SUPER_ADMIN decides who holds which People & Access / Access Packs /
  // portal sub-permissions. Holding one lets you do that thing to OTHER
  // people, within what you hold yourself -- never to yourself, never to a
  // SUPER_ADMIN, and never in a way that hands out more than you have.

  /** Not your own account, and not a SUPER_ADMIN's. */
  assertMayManageUser(
    actor: Pick<IJwtStaffPayload, 'role' | 'sub'> | undefined,
    target: { id: string; role: StaffRole },
  ) {
    if (!actor || isSuperAdmin(actor)) return;
    if (target.id === actor.sub) {
      throw new ForbiddenException('You cannot change your own account or access. Ask a super admin.');
    }
    if (target.role === StaffRole.SUPER_ADMIN) {
      throw new ForbiddenException("Only a super admin can change a super admin's account.");
    }
  }

  /** Never SUPER_ADMIN, and never a role whose baseline carries capabilities you lack. */
  async assertMayAssignRole(actor: IJwtStaffPayload | undefined, role: StaffRole) {
    if (!actor || isSuperAdmin(actor)) return;
    if (role === StaffRole.SUPER_ADMIN) {
      throw new ForbiddenException('Only a super admin can give someone the SUPER_ADMIN role.');
    }
    const [mine, rolePerms] = await Promise.all([
      this.resolveEffective(actor.sub, actor.role),
      this.prisma.role_permissions.findMany({
        where: { role },
        include: { permissions: { select: { key: true } } },
      }),
    ]);
    const held = new Set(mine.capabilityKeys);
    const above = rolePerms.map((rp) => rp.permissions.key).filter((k) => !held.has(k));
    if (above.length > 0) {
      throw new ForbiddenException(
        `You cannot give the ${role} role: it carries permissions you do not hold (${above.join(', ')}).`,
      );
    }
  }

  /**
   * Everything a change GIVES the target (tiles, sub-permissions, capabilities
   * present after but not before) must already be held by the actor. Taking
   * access away is never a leak.
   */
  async assertNoLeak(
    actor: IJwtStaffPayload | undefined,
    before: EffectiveAccess,
    after: EffectiveAccess,
  ) {
    if (!actor || isSuperAdmin(actor)) return;
    const mine = await this.resolveEffective(actor.sub, actor.role);
    const gained = (b: string[], a: string[], held: string[]) => {
      const had = new Set(b);
      const own = new Set(held);
      return a.filter((k) => !had.has(k) && !own.has(k));
    };
    const tiles = gained(before.tileIds, after.tileIds, mine.tileIds);
    const actions = gained(before.actionIds, after.actionIds, mine.actionIds);
    const caps = gained(before.capabilityKeys, after.capabilityKeys, mine.capabilityKeys);
    const leaked = [...tiles, ...actions, ...caps];
    if (leaked.length > 0) {
      throw new ForbiddenException(
        `You can only give access you hold yourself. Not yours to give: ${leaked.join(', ')}.`,
      );
    }
  }

  /**
   * For credential actions (set, reset or reveal a password, change a
   * username): becoming the target must not get you anything you lack, so
   * their access and scope have to fit inside yours.
   */
  async assertNotAbove(actor: IJwtStaffPayload | undefined, target: { id: string; role: StaffRole }) {
    if (!actor || isSuperAdmin(actor)) return;
    this.assertMayManageUser(actor, target);
    const [mine, theirs, theirScope] = await Promise.all([
      this.resolveEffective(actor.sub, actor.role),
      this.resolveEffective(target.id, target.role),
      this.scopeService.resolve(target.id),
    ]);
    const missing = (theirsKeys: string[], mineKeys: string[]) => {
      const own = new Set(mineKeys);
      return theirsKeys.filter((k) => !own.has(k));
    };
    const above = [
      ...missing(theirs.tileIds, mine.tileIds),
      ...missing(theirs.actionIds, mine.actionIds),
      ...missing(theirs.capabilityKeys, mine.capabilityKeys),
    ];
    if (above.length > 0) {
      throw new ForbiddenException(
        `This account holds access you do not (${above.slice(0, 8).join(', ')}${above.length > 8 ? ', …' : ''}), so you cannot use its password or username.`,
      );
    }
    this.assertGrantableScope(actor, theirScope, 'This account reaches outside your own scope');
  }

  /**
   * Scope given (or held) must fit inside the actor's, dimension by dimension.
   * Where the actor is restricted, an empty dimension means UNRESTRICTED and is
   * therefore wider than theirs -- refused too (this used to slip through).
   */
  assertGrantableScope(actor: IJwtStaffPayload, granted: Partial<UserScope>, prefix = 'You may not grant scope wider than your own') {
    if (isSuperAdmin(actor)) return;
    const mine = this.scopeService.scopeOf(actor);
    for (const field of Object.keys(EMPTY_SCOPE) as (keyof UserScope)[]) {
      if (mine[field].length === 0) continue;
      const requested = granted[field] ?? [];
      if (requested.length === 0) {
        throw new ForbiddenException(`${prefix}: ${field} would be unrestricted.`);
      }
      const outside = requested.filter((id) => !mine[field].includes(id));
      if (outside.length > 0) {
        throw new ForbiddenException(`${prefix}: ${field} ${outside.join(', ')}.`);
      }
    }
  }

  /**
   * Field-partitions setUserAccess between the Access tab (packs, tiles,
   * sub-permissions -> access.edit) and the Scope tab (scope -> scope.edit).
   * packIds / tileGrants ride along on every save from either tab, so they
   * count as touched only when they differ from what is stored.
   */
  private assertUserAccessFieldsEditable(
    actingUser: IJwtStaffPayload,
    dto: SetUserAccessDto,
    packIds: string[],
    grants: { tileId: string; allow: boolean }[],
    existingPacks: { pack_id: string }[],
    existingGrants: { tile_id: string; allow: boolean }[],
  ) {
    if (isSuperAdmin(actingUser)) return;
    const packsChanged =
      JSON.stringify([...packIds].sort()) !==
      JSON.stringify(existingPacks.map((p) => p.pack_id).sort());
    const grantsChanged =
      JSON.stringify([...grants].map((g) => [g.tileId, g.allow]).sort()) !==
      JSON.stringify(existingGrants.map((g) => [g.tile_id, g.allow]).sort());
    const touchesAccess = packsChanged || grantsChanged || dto.tileActionGrants !== undefined;
    const held = new Set(actingUser.actions ?? []);
    if (touchesAccess && !held.has(`${PEOPLE_ACCESS_TILE_ID}#access.edit`)) {
      throw new ForbiddenException('You do not have permission to edit access grants.');
    }
    if (dto.scope !== undefined && !held.has(`${PEOPLE_ACCESS_TILE_ID}#scope.edit`)) {
      throw new ForbiddenException('You do not have permission to edit data scope.');
    }
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

  async getUserAccess(userId: string, actingUser: IJwtStaffPayload) {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { id: true, username: true, role: true, campus_id: true, employee_profile: { select: TARGET_PROFILE_SELECT } },
    });
    if (!user) throw new NotFoundException(`User ${userId} not found`);
    this.assertCanManageUser(actingUser, user, userId);

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
    const actionsByPack = groupLiveActions(packActionRows);

    const roleKeySet = new Set(rolePerms.map((rp) => rp.permissions.key));
    const roleTileIds = MANIFEST_EFFECTIVE_TILES
      // Web tiles never inherit from the role (TAFSD-284), only Staff App tabs do.
      .filter((t) => !t.requiresExplicitAllow && t.capabilities.every((c) => roleKeySet.has(c)))
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
      // Retired actions (no longer in the manifest) are left out, so the editor
      // never resends them and trips assertActionsExist on the next save.
      actionGrants: actionGrants.filter((g) => MANIFEST_ACTION_KEYS.has(actionKey(g.tile_id, g.action_id))).map((g) => ({
        tileId: g.tile_id,
        actionId: g.action_id,
        allow: g.allow,
        note: g.note,
        grantedAt: g.granted_at,
      })),
      scope,
    };
  }

  async setUserAccess(
    userId: string,
    dto: SetUserAccessDto,
    actorId: string,
    actorLabel: string | undefined,
    actingUser: IJwtStaffPayload,
  ) {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { id: true, username: true, campus_id: true, role: true, employee_profile: { select: TARGET_PROFILE_SELECT } },
    });
    if (!user) throw new NotFoundException(`User ${userId} not found`);
    this.assertCanManageUser(actingUser, user, userId);
    this.assertMayManageUser(actingUser, user);
    if (dto.scope !== undefined) {
      this.assertGrantableScope(actingUser, dto.scope);
      await this.assertSegmentsFitDepartments(dto.scope);
      await this.assertStaffCategoriesFitDepartments(dto.scope);
    }

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
    this.assertUserAccessFieldsEditable(actingUser, dto, packIds, grants, existingPacks, existingGrants);
    const existingActionGrants = await readUntilMigrated(
      () =>
        this.prisma.user_tile_action_grants.findMany({
          where: { user_id: userId },
          select: { tile_id: true, action_id: true, allow: true },
        }),
      [] as { tile_id: string; action_id: string; allow: boolean }[],
    );

    if (!isSuperAdmin(actingUser)) {
      const [before, after] = await Promise.all([
        this.resolveEffective(userId, user.role),
        this.effectiveWith(userId, user.role, {
          packIds,
          grants,
          ...(dto.tileActionGrants !== undefined ? { actionGrants } : {}),
        }),
      ]);
      await this.assertNoLeak(actingUser, before, after);
    }

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

      // Replace the whole grant set in two statements. An upsert per grant
      // cost one round trip each, so a user with ~65 grants ran past the
      // transaction timeout and the save returned 500. Every row was rewritten
      // with a fresh granted_at anyway, so the stored result is the same.
      await tx.user_tile_grants.deleteMany({ where: { user_id: userId } });
      if (grants.length > 0) {
        await tx.user_tile_grants.createMany({
          data: grants.map((grant) => ({
            user_id: userId,
            tile_id: grant.tileId,
            allow: grant.allow,
            granted_by: actorId,
            note: grant.note ?? null,
          })),
          skipDuplicates: true,
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
    }, { maxWait: 10000, timeout: 20000 });
    this.invalidateLiveSession(userId);

    // Collected and written in one insert after the change commits; one
    // awaited log() per changed tile was another round trip each.
    const auditEntries: AuditLogParams[] = [];
    const beforePacks = existingPacks.map((p) => p.pack_id).sort().join(',');
    const afterPacks = [...packIds].sort().join(',');
    const changedBy = actorLabel ?? actorId;
    if (beforePacks !== afterPacks) {
      auditEntries.push({
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
      auditEntries.push({
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
        auditEntries.push({
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
        auditEntries.push({
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

    await this.auditLogs.logMany(auditEntries);

    return this.getUserAccess(userId, actingUser);
  }

  /**
   * For a non-SUPER_ADMIN holder of access_packs#manage: a pack assigned to
   * yourself is your own access, so you cannot edit or delete it; and you can
   * only ADD tiles and sub-permissions you hold yourself (removing is fine).
   * `packId` null is a new pack.
   */
  private async assertPackChangeAllowed(
    actor: IJwtStaffPayload | undefined,
    packId: string | null,
    tileIds: string[],
    tileActions: { tileId: string; actionId: string }[],
  ) {
    if (!actor || isSuperAdmin(actor)) return;
    if (packId) {
      const mineToo = await this.prisma.user_access_packs.count({
        where: { pack_id: packId, user_id: actor.sub },
      });
      if (mineToo > 0) {
        throw new ForbiddenException('This pack is assigned to you, so only a super admin can change it.');
      }
    }
    const [mine, existingTiles, existingActions] = await Promise.all([
      this.resolveEffective(actor.sub, actor.role),
      packId
        ? this.prisma.access_pack_tiles.findMany({ where: { pack_id: packId }, select: { tile_id: true } })
        : Promise.resolve([] as { tile_id: string }[]),
      packId ? this.readActionsOfPacks([packId]) : Promise.resolve([] as { tileId: string; actionId: string }[]),
    ]);
    const heldTiles = new Set(mine.tileIds);
    const heldActions = new Set(mine.actionIds);
    const hadTiles = new Set(existingTiles.map((t) => t.tile_id));
    const hadActions = new Set(existingActions.map((a) => actionKey(a.tileId, a.actionId)));
    const leaked = [
      ...tileIds.filter((t) => !hadTiles.has(t) && !heldTiles.has(t)),
      ...tileActions
        .map((a) => actionKey(a.tileId, a.actionId))
        .filter((k) => !hadActions.has(k) && !heldActions.has(k)),
    ];
    if (leaked.length > 0) {
      throw new ForbiddenException(
        `You can only put access you hold yourself into a pack. Not yours to give: ${leaked.join(', ')}.`,
      );
    }
  }

  async listPacks() {
    const [packs, actionRows] = await Promise.all([
      this.prisma.access_packs.findMany({
        orderBy: [{ is_system: 'desc' }, { name: 'asc' }],
        include: { tiles: { select: { tile_id: true } } },
      }),
      readUntilMigrated(
        () =>
          this.prisma.access_pack_tile_actions.findMany({
            select: { pack_id: true, tile_id: true, action_id: true },
          }),
        [] as { pack_id: string; tile_id: string; action_id: string }[],
      ),
    ]);
    const actionsByPack = groupLiveActions(actionRows);
    return packs.map((p) => ({ ...p, tileActions: actionsByPack.get(p.id) ?? [] }));
  }

  async createPack(dto: CreateAccessPackDto, actorLabel?: string, actingUser?: IJwtStaffPayload) {
    const tileIds = [...new Set(dto.tileIds ?? [])];
    await this.assertTilesExist(tileIds);
    const tileActions = dto.tileActions ?? [];
    this.assertActionsExist(tileActions);
    await this.assertPackChangeAllowed(actingUser, null, tileIds, tileActions);

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

  async updatePack(id: string, dto: UpdateAccessPackDto, actorLabel?: string, actingUser?: IJwtStaffPayload) {
    const existing = await this.prisma.access_packs.findUnique({
      where: { id },
      include: { tiles: { select: { tile_id: true } } },
    });
    if (!existing) throw new NotFoundException(`Access pack ${id} not found`);

    const tileIds = dto.tileIds !== undefined ? [...new Set(dto.tileIds)] : undefined;
    if (tileIds) await this.assertTilesExist(tileIds);

    const tileActions = dto.tileActions;
    if (tileActions) this.assertActionsExist(tileActions);
    await this.assertPackChangeAllowed(actingUser, id, tileIds ?? [], tileActions ?? []);

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
    // Everyone holding the pack sees the change on their next request.
    this.invalidateLiveSession();

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

  async deletePack(id: string, actorLabel?: string, actingUser?: IJwtStaffPayload) {
    await this.assertPackChangeAllowed(actingUser, id, [], []);
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
    this.invalidateLiveSession();
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
