import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ec_fee_frequency } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { EC_SEARCH_LIMIT } from '../ec.constants';
import { actorOf, normalizeEcMonths, normalizeEcName } from '../ec-common.util';
import { CreateEcFeeHeadDto, EcFeeHeadListQueryDto, UpdateEcFeeHeadDto } from './dto/ec-fee-heads.dto';

const HEAD_SELECT = {
    id: true,
    name: true,
    frequency: true,
    months: true,
    sort_order: true,
    is_active: true,
    created_by: true,
    created_at: true,
    updated_at: true,
} as const;

/**
 * TAFSD-605: extracurricular fee heads, the EC twin of School Setup → Fee Types.
 * A head is a name, a frequency and the months it falls in; its amount per
 * class lives in ec_class_fee_schedule and per student in ec_student_charges.
 */
@Injectable()
export class EcFeeHeadsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly auditLogs: AuditLogsService,
    ) {}

    /** A ONE_TIME head falls in exactly one month; a MONTHLY head in at least one. */
    private checkMonths(frequency: ec_fee_frequency, months: number[]): number[] {
        const normalized = normalizeEcMonths(months);
        if (normalized.length === 0) throw new BadRequestException('Pick at least one month');
        if (frequency === ec_fee_frequency.ONE_TIME && normalized.length !== 1) {
            throw new BadRequestException('A one-time head is charged in exactly one month');
        }
        return normalized;
    }

    private nameTaken(err: unknown, name: string): never {
        if ((err as { code?: string })?.code === 'P2002') {
            throw new ConflictException(`A head named "${name}" already exists`);
        }
        throw err;
    }

    async list(query: EcFeeHeadListQueryDto) {
        const states = query.states ?? [];
        const where: Prisma.ec_fee_headsWhereInput = {
            ...(query.q?.trim() ? { name: { contains: query.q.trim(), mode: 'insensitive' } } : {}),
            ...(query.frequencies?.length ? { frequency: { in: query.frequencies } } : {}),
            // Both states ticked is the same as none: everything.
            ...(states.length === 1 ? { is_active: states[0] === 'ACTIVE' } : {}),
        };
        const rows = await this.prisma.ec_fee_heads.findMany({
            where,
            select: { ...HEAD_SELECT, _count: { select: { ec_student_charges: true, ec_class_fee_schedule: true } } },
            orderBy: [{ sort_order: 'asc' }, { name: 'asc' }],
        });
        return rows.map(({ _count, ...h }) => ({
            ...h,
            charges_count: _count.ec_student_charges,
            schedule_rows_count: _count.ec_class_fee_schedule,
        }));
    }

    /** Active heads for pickers on every EC page. */
    async options() {
        return this.prisma.ec_fee_heads.findMany({
            where: { is_active: true },
            select: { id: true, name: true, frequency: true, months: true, sort_order: true },
            orderBy: [{ sort_order: 'asc' }, { name: 'asc' }],
        });
    }

    /** Rule 2 shape: empty text finds nothing; a small projection; at most 20. */
    async searchSimple(q: string | undefined) {
        const text = (q ?? '').trim();
        if (!text) return [];
        return this.prisma.ec_fee_heads.findMany({
            where: { name: { contains: text, mode: 'insensitive' } },
            select: { id: true, name: true, frequency: true, is_active: true },
            orderBy: [{ is_active: 'desc' }, { sort_order: 'asc' }, { name: 'asc' }],
            take: EC_SEARCH_LIMIT,
        });
    }

    async create(dto: CreateEcFeeHeadDto, user: IJwtStaffPayload) {
        const name = normalizeEcName(dto.name);
        if (name.length < 2) throw new BadRequestException('Give the head a name');
        const months = this.checkMonths(dto.frequency, dto.months);
        const head = await this.prisma.ec_fee_heads
            .create({
                data: {
                    name,
                    frequency: dto.frequency,
                    months,
                    sort_order: dto.sort_order ?? 0,
                    created_by: actorOf(user),
                },
                select: HEAD_SELECT,
            })
            .catch((err) => this.nameTaken(err, name));
        await this.auditLogs.log({
            entity_type: 'EC_FEE_HEAD',
            entity_id: String(head.id),
            action: 'CREATED',
            section: 'finance',
            new_value: JSON.stringify({ name, frequency: dto.frequency, months }),
            changed_by: actorOf(user),
        });
        return head;
    }

    /**
     * Editing a head never touches charges already made from it: they keep
     * their own months and amounts. New assignments follow the new settings.
     */
    async update(id: number, dto: UpdateEcFeeHeadDto, user: IJwtStaffPayload) {
        const existing = await this.prisma.ec_fee_heads.findUnique({ where: { id }, select: HEAD_SELECT });
        if (!existing) throw new NotFoundException(`Extracurricular head #${id} not found`);

        const name = dto.name !== undefined ? normalizeEcName(dto.name) : existing.name;
        if (name.length < 2) throw new BadRequestException('Give the head a name');
        const frequency = dto.frequency ?? existing.frequency;
        const months =
            dto.months !== undefined || dto.frequency !== undefined
                ? this.checkMonths(frequency, dto.months ?? existing.months)
                : existing.months;

        const head = await this.prisma.ec_fee_heads
            .update({
                where: { id },
                data: {
                    name,
                    frequency,
                    months,
                    ...(dto.sort_order !== undefined ? { sort_order: dto.sort_order } : {}),
                    ...(dto.is_active !== undefined ? { is_active: dto.is_active } : {}),
                },
                select: HEAD_SELECT,
            })
            .catch((err) => this.nameTaken(err, name));

        const before = { name: existing.name, frequency: existing.frequency, months: existing.months, sort_order: existing.sort_order, is_active: existing.is_active };
        const after = { name: head.name, frequency: head.frequency, months: head.months, sort_order: head.sort_order, is_active: head.is_active };
        if (JSON.stringify(before) !== JSON.stringify(after)) {
            await this.auditLogs.log({
                entity_type: 'EC_FEE_HEAD',
                entity_id: String(id),
                action: 'UPDATED',
                section: 'finance',
                old_value: JSON.stringify(before),
                new_value: JSON.stringify(after),
                changed_by: actorOf(user),
            });
        }
        return head;
    }

    /** Only an unused head can be deleted (its class amounts go with it); a used one is deactivated instead. */
    async remove(id: number, user: IJwtStaffPayload) {
        const head = await this.prisma.ec_fee_heads.findUnique({
            where: { id },
            select: { ...HEAD_SELECT, _count: { select: { ec_student_charges: true } } },
        });
        if (!head) throw new NotFoundException(`Extracurricular head #${id} not found`);
        if (head._count.ec_student_charges > 0) {
            throw new ConflictException(
                `"${head.name}" is charged to ${head._count.ec_student_charges} student month(s). Deactivate it instead of deleting it.`,
            );
        }
        try {
            await this.prisma.ec_fee_heads.delete({ where: { id } });
        } catch (err) {
            // A charge made between the count and the delete.
            if ((err as { code?: string })?.code === 'P2003') {
                throw new ConflictException(`"${head.name}" is now in use. Deactivate it instead of deleting it.`);
            }
            throw err;
        }
        await this.auditLogs.log({
            entity_type: 'EC_FEE_HEAD',
            entity_id: String(id),
            action: 'DELETED',
            section: 'finance',
            old_value: JSON.stringify({ name: head.name, frequency: head.frequency, months: head.months }),
            changed_by: actorOf(user),
        });
        return { id };
    }
}
