import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { ScopeService } from '../../../common/scope/scope.service';
import { AuditLogsService, type AuditLogParams } from '../../audit-logs/audit-logs.service';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { EC_SCHEDULE_LOCK_KEY } from '../ec.constants';
import { actorOf, normalizeEcAcademicYear } from '../ec-common.util';
import { CopyEcClassScheduleDto, EcClassScheduleQueryDto, UpsertEcClassScheduleDto } from './dto/ec-class-schedule.dto';

const ROW_INCLUDE = {
    classes: { select: { id: true, description: true } },
    campuses: { select: { id: true, campus_name: true } },
    ec_fee_heads: { select: { id: true, name: true } },
} as const;
type Row = Prisma.ec_class_fee_scheduleGetPayload<{ include: typeof ROW_INCLUDE }>;

const view = (r: Row) => ({
    id: r.id,
    class_id: r.class_id,
    class_name: r.classes.description,
    fee_head_id: r.fee_head_id,
    fee_head_name: r.ec_fee_heads.name,
    campus_id: r.campus_id,
    campus_name: r.campuses?.campus_name ?? null,
    academic_year: r.academic_year,
    amount: Number(r.amount),
    updated_by: r.updated_by,
    updated_at: r.updated_at,
});

const cellKey = (c: { class_id: number; fee_head_id: number; campus_id: number | null }) =>
    `${c.class_id}|${c.fee_head_id}|${c.campus_id ?? 'all'}`;

/**
 * TAFSD-605: what each extracurricular head costs per class per academic year,
 * the EC twin of the Class Fee Schedule. A row with no campus applies to every
 * campus; a campus row beats it when a student is charged.
 *
 * Scope follows the academic schedule: an all-campus row is a real default, so
 * every caller sees it; only campus rows are scoped. A campus-scoped caller can
 * change only their own campuses' rows, never an all-campus one.
 */
@Injectable()
export class EcClassScheduleService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly scope: ScopeService,
        private readonly auditLogs: AuditLogsService,
    ) {}

    /** The campuses the caller is held to, or null when campus is unrestricted. */
    private scopedCampuses(user: IJwtStaffPayload): number[] | null {
        if (this.scope.isExempt(user)) return null;
        const campuses = this.scope.scopeOf(user).campuses;
        return campuses.length > 0 ? [...campuses] : null;
    }

    private campusWhere(user: IJwtStaffPayload): Prisma.ec_class_fee_scheduleWhereInput {
        const campuses = this.scopedCampuses(user);
        return campuses ? { OR: [{ campus_id: { in: campuses } }, { campus_id: null }] } : {};
    }

    private canSee(user: IJwtStaffPayload, campusId: number | null): boolean {
        const campuses = this.scopedCampuses(user);
        return !campuses || campusId == null || campuses.includes(campusId);
    }

    private assertTarget(user: IJwtStaffPayload, campusId: number | null): void {
        const campuses = this.scopedCampuses(user);
        if (!campuses) return;
        if (campusId == null) {
            throw new ForbiddenException('Only a user with every campus in scope may set an amount for all campuses.');
        }
        if (!campuses.includes(campusId)) throw new ForbiddenException('Outside your assigned campus scope.');
    }

    async list(query: EcClassScheduleQueryDto, user: IJwtStaffPayload) {
        const year = normalizeEcAcademicYear(query.academic_year);
        for (const c of query.campus_ids ?? []) this.scope.assertCampus(user, c);
        const rows = await this.prisma.ec_class_fee_schedule.findMany({
            where: {
                AND: [
                    { academic_year: year },
                    query.class_ids?.length ? { class_id: { in: query.class_ids } } : {},
                    query.fee_head_ids?.length ? { fee_head_id: { in: query.fee_head_ids } } : {},
                    query.campus_ids?.length ? { OR: [{ campus_id: { in: query.campus_ids } }, { campus_id: null }] } : {},
                    this.campusWhere(user),
                ],
            },
            include: ROW_INCLUDE,
            orderBy: [{ class_id: 'asc' }, { fee_head_id: 'asc' }, { campus_id: 'asc' }],
        });
        return rows.map(view);
    }

    /**
     * Save a batch of grid cells. A number sets the amount; null clears the cell.
     * Runs under one advisory lock so two saves can never both create the same
     * all-campus row (Postgres treats NULL campus ids as distinct in the unique).
     */
    async upsert(dto: UpsertEcClassScheduleDto, user: IJwtStaffPayload) {
        const year = normalizeEcAcademicYear(dto.academic_year);
        const seen = new Set<string>();
        for (const cell of dto.cells) {
            const key = cellKey(cell);
            if (seen.has(key)) throw new BadRequestException('The same class, head and campus appears twice in one save');
            seen.add(key);
            this.assertTarget(user, cell.campus_id);
        }

        const classIds = [...new Set(dto.cells.map((c) => c.class_id))];
        const headIds = [...new Set(dto.cells.map((c) => c.fee_head_id))];
        const campusIds = [...new Set(dto.cells.map((c) => c.campus_id).filter((c): c is number => c != null))];
        const [classes, heads, campuses] = await Promise.all([
            this.prisma.classes.findMany({ where: { id: { in: classIds } }, select: { id: true } }),
            this.prisma.ec_fee_heads.findMany({ where: { id: { in: headIds } }, select: { id: true } }),
            campusIds.length
                ? this.prisma.campuses.findMany({ where: { id: { in: campusIds } }, select: { id: true } })
                : Promise.resolve([] as { id: number }[]),
        ]);
        if (classes.length !== classIds.length) throw new BadRequestException('A class in this save no longer exists');
        if (heads.length !== headIds.length) throw new BadRequestException('A head in this save no longer exists');
        if (campuses.length !== campusIds.length) throw new BadRequestException('A campus in this save no longer exists');

        const by = actorOf(user);
        const audit: AuditLogParams[] = [];
        let saved = 0;
        let cleared = 0;
        await this.prisma.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${EC_SCHEDULE_LOCK_KEY}))`;
            for (const cell of dto.cells) {
                const existing = await tx.ec_class_fee_schedule.findFirst({
                    where: { class_id: cell.class_id, fee_head_id: cell.fee_head_id, campus_id: cell.campus_id ?? null, academic_year: year },
                    select: { id: true, amount: true },
                });
                const label = `class=${cell.class_id}, head=${cell.fee_head_id}, campus=${cell.campus_id ?? 'all'}, year=${year}`;
                if (cell.amount == null) {
                    if (!existing) continue;
                    await tx.ec_class_fee_schedule.delete({ where: { id: existing.id } });
                    cleared++;
                    audit.push({ entity_type: 'EC_CLASS_FEE_SCHEDULE', entity_id: String(existing.id), action: 'DELETED', section: 'finance', old_value: `${label}, amount=${Number(existing.amount)}`, changed_by: by });
                } else if (existing) {
                    if (Number(existing.amount) === cell.amount) continue;
                    await tx.ec_class_fee_schedule.update({ where: { id: existing.id }, data: { amount: cell.amount, updated_by: by } });
                    saved++;
                    audit.push({ entity_type: 'EC_CLASS_FEE_SCHEDULE', entity_id: String(existing.id), action: 'UPDATED', section: 'finance', field: 'amount', old_value: String(Number(existing.amount)), new_value: String(cell.amount), note: label, changed_by: by });
                } else {
                    const row = await tx.ec_class_fee_schedule.create({
                        data: { class_id: cell.class_id, fee_head_id: cell.fee_head_id, campus_id: cell.campus_id ?? null, academic_year: year, amount: cell.amount, updated_by: by },
                        select: { id: true },
                    });
                    saved++;
                    audit.push({ entity_type: 'EC_CLASS_FEE_SCHEDULE', entity_id: String(row.id), action: 'CREATED', section: 'finance', new_value: `${label}, amount=${cell.amount}`, changed_by: by });
                }
            }
        });
        await this.auditLogs.logMany(audit);
        return { saved, cleared };
    }

    async remove(id: number, user: IJwtStaffPayload) {
        const row = await this.prisma.ec_class_fee_schedule.findUnique({ where: { id }, include: ROW_INCLUDE });
        if (!row || !this.canSee(user, row.campus_id)) throw new NotFoundException(`Class amount #${id} not found`);
        this.assertTarget(user, row.campus_id);
        await this.prisma.ec_class_fee_schedule.delete({ where: { id } });
        await this.auditLogs.log({
            entity_type: 'EC_CLASS_FEE_SCHEDULE',
            entity_id: String(id),
            action: 'DELETED',
            section: 'finance',
            old_value: `class=${row.classes.description}, head=${row.ec_fee_heads.name}, campus=${row.campuses?.campus_name ?? 'all'}, year=${row.academic_year}, amount=${Number(row.amount)}`,
            changed_by: actorOf(user),
        });
        return { id };
    }

    /**
     * Copy one year's amounts into another. Only rows the caller could edit are
     * copied (a campus-scoped caller copies their own campuses, never the
     * all-campus rows). Amounts already set in the target year are kept unless
     * `overwrite` is on.
     */
    async copyYear(dto: CopyEcClassScheduleDto, user: IJwtStaffPayload) {
        const from = normalizeEcAcademicYear(dto.from_year);
        const to = normalizeEcAcademicYear(dto.to_year);
        if (from === to) throw new BadRequestException('Pick two different years');
        const campuses = this.scopedCampuses(user);

        const source = await this.prisma.ec_class_fee_schedule.findMany({
            where: { academic_year: from, ...(campuses ? { campus_id: { in: campuses } } : {}) },
            select: { class_id: true, fee_head_id: true, campus_id: true, amount: true },
        });
        if (source.length === 0) throw new BadRequestException(`${from} has no extracurricular amounts you can copy`);

        const by = actorOf(user);
        let created = 0;
        let updated = 0;
        let kept = 0;
        await this.prisma.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${EC_SCHEDULE_LOCK_KEY}))`;
            const target = await tx.ec_class_fee_schedule.findMany({
                where: { academic_year: to },
                select: { id: true, class_id: true, fee_head_id: true, campus_id: true, amount: true },
            });
            const byKey = new Map(target.map((t) => [cellKey(t), t]));
            for (const s of source) {
                const existing = byKey.get(cellKey(s));
                if (existing) {
                    if (!dto.overwrite || Number(existing.amount) === Number(s.amount)) {
                        kept++;
                        continue;
                    }
                    await tx.ec_class_fee_schedule.update({ where: { id: existing.id }, data: { amount: s.amount, updated_by: by } });
                    updated++;
                } else {
                    await tx.ec_class_fee_schedule.create({
                        data: { class_id: s.class_id, fee_head_id: s.fee_head_id, campus_id: s.campus_id, academic_year: to, amount: s.amount, updated_by: by },
                    });
                    created++;
                }
            }
        }, { timeout: 30_000 });

        await this.auditLogs.log({
            entity_type: 'EC_CLASS_FEE_SCHEDULE',
            entity_id: `copy:${from}->${to}`,
            action: 'CREATED',
            section: 'finance',
            new_value: JSON.stringify({ from, to, overwrite: !!dto.overwrite, created, updated, kept }),
            changed_by: by,
        });
        return { from, to, created, updated, kept };
    }
}
