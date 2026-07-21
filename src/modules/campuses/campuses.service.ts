import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { SectionGenderMode } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { StudentAllocationService } from '../student-allocation/student-allocation.service';
import { CreateCampusDto } from './dto/create-campus.dto';
import { BulkUpdateCampusesDto } from './dto/bulk-update-campuses.dto';
import { UpsertCampusSectionDto } from './dto/upsert-campus-section.dto';

@Injectable()
export class CampusesService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly auditLogs: AuditLogsService,
        private readonly allocation: StudentAllocationService,
    ) { }

    private readonly campusIncludes = {
        campus_classes: {
            where: { is_active: true },
            orderBy: { class_id: 'asc' as const },
            select: {
                id: true,
                is_active: true,
                classes: {
                    select: {
                        id: true,
                        description: true,
                        class_code: true,
                        academic_system: true,
                    },
                },
            },
        },
        campus_sections: {
            where: { is_active: true },
            select: {
                id: true,
                is_active: true,
                class_id: true,
                section_id: true,
                student_capacity: true,
                gender_mode: true,
                sections: {
                    select: {
                        id: true,
                        description: true,
                    },
                },
                classes: {
                    select: {
                        id: true,
                        description: true,
                        class_code: true,
                    },
                },
            },
        },
    };

    private async transformCampusData(campus: any) {
        const { campus_classes, campus_sections, ...rest } = campus;

        const occupancyMap = await this.allocation.computeOccupancyStatsBatch(
            (campus_sections || []).map((cs: any) => ({
                campus_id: campus.id,
                class_id: cs.class_id,
                section_id: cs.section_id,
                student_capacity: cs.student_capacity ?? null,
                gender_mode: cs.gender_mode ?? SectionGenderMode.COED,
            })),
        );

        const offered_classes = campus_classes.map((cc: any) => {
            const cls = cc.classes;
            const sections = campus_sections
                .filter((cs: any) => cs.class_id === cls.id)
                .map((cs: any) => {
                    const key = `${campus.id}:${cs.class_id}:${cs.section_id}`;
                    const occupancy = occupancyMap.get(key) ?? {
                        enrolled_count: 0,
                        male_count: 0,
                        female_count: 0,
                        unknown_count: 0,
                        remaining_seats: cs.student_capacity ?? null,
                        is_full: false,
                        capacity_conflict_count: 0,
                        gender_conflict_count: 0,
                    };

                    return {
                        id: cs.sections.id,
                        description: cs.sections.description,
                        campus_section_id: cs.id,
                        is_active: cs.is_active,
                        student_capacity: cs.student_capacity ?? null,
                        gender_mode: cs.gender_mode ?? SectionGenderMode.COED,
                        enrolled_count: occupancy.enrolled_count,
                        remaining_seats: occupancy.remaining_seats,
                        is_full: occupancy.is_full,
                        male_count: occupancy.male_count,
                        female_count: occupancy.female_count,
                        unknown_count: occupancy.unknown_count,
                        capacity_conflict_count: occupancy.capacity_conflict_count,
                        gender_conflict_count: occupancy.gender_conflict_count,
                    };
                });

            return {
                id: cls.id,
                description: cls.description,
                class_code: cls.class_code,
                academic_system: cls.academic_system,
                campus_class_id: cc.id,
                is_active: cc.is_active,
                sections,
            };
        });

        return {
            ...rest,
            offered_classes,
        };
    }

    async findAll() {
        const campuses = await this.prisma.campuses.findMany({
            orderBy: { campus_name: 'asc' },
            include: this.campusIncludes,
        });
        return Promise.all(campuses.map((c) => this.transformCampusData(c)));
    }

    async findOne(id: number) {
        const campus = await this.prisma.campuses.findUnique({
            where: { id },
            include: this.campusIncludes,
        });
        if (!campus) throw new NotFoundException('Campus not found');
        return this.transformCampusData(campus);
    }

    async getDependencies(id: number) {
        const [students, staff, classes] = await Promise.all([
            this.prisma.students.count({ where: { campus_id: id, deleted_at: null } }),
            this.prisma.users.count({ where: { campus_id: id, is_active: true } }),
            this.prisma.campus_classes.count({ where: { campus_id: id } }),
        ]);
        return { students, staff, classes };
    }

    async create(dto: CreateCampusDto, changedBy?: string) {
        const record = await this.prisma.campuses.create({
            data: {
                campus_code: dto.campus_code,
                campus_name: dto.campus_name,
                address: dto.address,
                campus_prefix: dto.campus_prefix,
            } as any,
        });
        this.auditLogs.log({ entity_type: 'CAMPUS', entity_id: String(record.id), action: 'CREATED', section: 'school-setup', new_value: dto.campus_name, changed_by: changedBy ?? 'system' });
        return record;
    }

    async bulkUpdate(dto: BulkUpdateCampusesDto, changedBy?: string) {
        if (!dto.items || dto.items.length === 0) {
            return [];
        }

        const existingIds = dto.items.filter((i) => i.id).map((i) => i.id!);
        const beforeMap = new Map(
            (
                await this.prisma.campuses.findMany({
                    where: { id: { in: existingIds } },
                    select: { id: true, campus_code: true, campus_name: true, address: true, campus_prefix: true },
                })
            ).map((c) => [c.id, c]),
        );

        const updated = await this.prisma.$transaction(
            dto.items.map((item) => {
                if (item.id) {
                    return this.prisma.campuses.update({
                        where: { id: item.id },
                        data: {
                            ...(item.campus_code !== undefined && {
                                campus_code: item.campus_code,
                            }),
                            ...(item.campus_name !== undefined && {
                                campus_name: item.campus_name,
                            }),
                            ...(item.address !== undefined && {
                                address: item.address,
                            }),
                            ...(item.campus_prefix !== undefined && {
                                campus_prefix: item.campus_prefix,
                            }),
                        } as any,
                    });
                } else {
                    return this.prisma.campuses.create({
                        data: {
                            campus_code: item.campus_code || '',
                            campus_name: item.campus_name || '',
                            address: item.address,
                            campus_prefix: item.campus_prefix,
                        } as any,
                    });
                }
            }),
        );

        const actor = changedBy ?? 'system';
        for (const record of updated) {
            const before = beforeMap.get(record.id);
            if (!before) {
                await this.auditLogs.log({
                    entity_type: 'CAMPUS',
                    entity_id: String(record.id),
                    action: 'CREATED',
                    section: 'school-setup',
                    new_value: record.campus_name,
                    changed_by: actor,
                    note: `Created campus #${record.id} ("${record.campus_name}", code ${record.campus_code}) via bulk update.`,
                });
                continue;
            }
            const changes: string[] = [];
            if (before.campus_code !== record.campus_code) {
                changes.push(`code "${before.campus_code}" → "${record.campus_code}"`);
            }
            if (before.campus_name !== record.campus_name) {
                changes.push(`name "${before.campus_name}" → "${record.campus_name}"`);
            }
            if ((before as any).address !== (record as any).address) {
                changes.push(`address "${(before as any).address ?? '—'}" → "${(record as any).address ?? '—'}"`);
            }
            if ((before as any).campus_prefix !== (record as any).campus_prefix) {
                changes.push(`prefix "${(before as any).campus_prefix ?? '—'}" → "${(record as any).campus_prefix ?? '—'}"`);
            }
            if (changes.length > 0) {
                await this.auditLogs.log({
                    entity_type: 'CAMPUS',
                    entity_id: String(record.id),
                    action: 'UPDATED',
                    section: 'school-setup',
                    changed_by: actor,
                    note: `Campus #${record.id} ("${before.campus_name}") bulk-updated: ${changes.join(', ')}.`,
                });
            }
        }

        return updated;
    }


    async delete(id: number, changedBy?: string) {
        const campus = await this.prisma.campuses.findUnique({ where: { id }, select: { campus_name: true } });
        const record = await this.prisma.$transaction(async (tx) => {
            const studentCount = await tx.students.count({
                where: { campus_id: id, deleted_at: null },
            });
            if (studentCount > 0) {
                throw new BadRequestException(
                    `Cannot delete campus: ${studentCount} active student record(s) exist in this campus. Please reassign or remove them first.`,
                );
            }

            await tx.users.updateMany({
                where: { campus_id: id },
                data: { campus_id: null },
            });

            await tx.class_fee_schedule.updateMany({
                where: { campus_id: id },
                data: { campus_id: null },
            });

            await tx.campus_sections.deleteMany({
                where: { campus_id: id },
            });

            await tx.campus_classes.deleteMany({
                where: { campus_id: id },
            });

            return tx.campuses.delete({
                where: { id },
            });
        });
        this.auditLogs.log({ entity_type: 'CAMPUS', entity_id: String(id), action: 'DELETED', section: 'school-setup', old_value: campus?.campus_name ?? undefined, changed_by: changedBy ?? 'system' });
        return record;
    }

    // ─── Campus Classes ───────────────────────────────────────────────────────

    async upsertCampusClass(campusId: number, classId: number, isActive: boolean = true, changedBy?: string) {
        const [campus, cls, existing] = await Promise.all([
            this.prisma.campuses.findUnique({ where: { id: campusId }, select: { id: true, campus_name: true } }),
            this.prisma.classes.findUnique({ where: { id: classId }, select: { id: true, class_code: true, description: true } }),
            this.prisma.campus_classes.findUnique({
                where: { campus_id_class_id: { campus_id: campusId, class_id: classId } },
                select: { is_active: true },
            }),
        ]);
        if (!campus) throw new NotFoundException(`Campus #${campusId} not found`);
        if (!cls) throw new NotFoundException(`Class #${classId} not found`);

        await this.prisma.campus_classes.upsert({
            where: { campus_id_class_id: { campus_id: campusId, class_id: classId } },
            update: { is_active: isActive },
            create: { campus_id: campusId, class_id: classId, is_active: isActive },
        });

        const classLabel = `${cls.class_code} – ${cls.description}`;
        if (!existing) {
            await this.auditLogs.log({
                entity_type: 'CAMPUS',
                entity_id: String(campusId),
                action: 'UPDATED',
                section: 'school-setup',
                field: 'campus_class',
                new_value: classLabel,
                changed_by: changedBy ?? 'system',
                note: `Added class #${classId} (${classLabel}) to campus #${campusId} ("${campus.campus_name}"), is_active=${isActive}.`,
            });
        } else if (existing.is_active !== isActive) {
            await this.auditLogs.log({
                entity_type: 'CAMPUS',
                entity_id: String(campusId),
                action: 'UPDATED',
                section: 'school-setup',
                field: 'campus_class.is_active',
                old_value: String(existing.is_active),
                new_value: String(isActive),
                changed_by: changedBy ?? 'system',
                note: `Class #${classId} (${classLabel}) on campus #${campusId} ("${campus.campus_name}") is_active ${existing.is_active} → ${isActive}.`,
            });
        }

        return this.findOne(campusId);
    }

    async removeClassFromCampus(campusId: number, classId: number, changedBy?: string) {
        const [campus, cls] = await Promise.all([
            this.prisma.campuses.findUnique({ where: { id: campusId }, select: { campus_name: true } }),
            this.prisma.classes.findUnique({ where: { id: classId }, select: { class_code: true, description: true } }),
        ]);

        const studentCount = await this.prisma.students.count({
            where: { campus_id: campusId, class_id: classId, deleted_at: null },
        });
        if (studentCount > 0) {
            throw new BadRequestException(
                `Cannot remove class #${classId}: ${studentCount} student(s) are currently assigned to it at this campus`,
            );
        }

        try {
            await this.prisma.$transaction([
                this.prisma.campus_sections.deleteMany({
                    where: { campus_id: campusId, class_id: classId },
                }),
                this.prisma.campus_classes.delete({
                    where: { campus_id_class_id: { campus_id: campusId, class_id: classId } },
                }),
            ]);

            const classLabel = cls ? `${cls.class_code} – ${cls.description}` : `#${classId}`;
            await this.auditLogs.log({
                entity_type: 'CAMPUS',
                entity_id: String(campusId),
                action: 'UPDATED',
                section: 'school-setup',
                field: 'campus_class',
                old_value: classLabel,
                changed_by: changedBy ?? 'system',
                note: `Removed class #${classId} (${classLabel}) from campus #${campusId} ("${campus?.campus_name ?? '—'}"), including its campus sections.`,
            });

            return this.findOne(campusId);
        } catch (e: any) {
            if (e?.code === 'P2025') {
                throw new NotFoundException(`Class #${classId} is not offered at campus #${campusId}`);
            }
            throw e;
        }
    }

    // ─── Campus Sections ──────────────────────────────────────────────────────

    async upsertCampusSection(
        campusId: number,
        classId: number,
        sectionId: number,
        dto: UpsertCampusSectionDto = {},
        changedBy?: string,
    ) {
        const isActive = dto.is_active ?? true;
        if (dto.student_capacity !== undefined && dto.student_capacity !== null && dto.student_capacity < 1) {
            throw new BadRequestException('student_capacity must be null (unlimited) or a positive integer');
        }

        const [campus, cls, section, existing] = await Promise.all([
            this.prisma.campuses.findUnique({ where: { id: campusId }, select: { id: true, campus_name: true } }),
            this.prisma.classes.findUnique({ where: { id: classId }, select: { id: true, class_code: true, description: true } }),
            this.prisma.sections.findUnique({ where: { id: sectionId }, select: { id: true, description: true } }),
            this.prisma.campus_sections.findUnique({
                where: {
                    campus_id_class_id_section_id: {
                        campus_id: campusId,
                        class_id: classId,
                        section_id: sectionId,
                    },
                },
                select: { is_active: true, student_capacity: true, gender_mode: true },
            }),
        ]);

        if (!campus) throw new NotFoundException(`Campus #${campusId} not found`);
        if (!cls) throw new NotFoundException(`Class #${classId} not found`);
        if (!section) throw new NotFoundException(`Section #${sectionId} not found`);

        await this.prisma.campus_classes.upsert({
            where: { campus_id_class_id: { campus_id: campusId, class_id: classId } },
            update: { is_active: true },
            create: { campus_id: campusId, class_id: classId, is_active: true },
        });

        const updateData: {
            is_active: boolean;
            student_capacity?: number | null;
            gender_mode?: SectionGenderMode;
        } = { is_active: isActive };

        if (dto.student_capacity !== undefined) {
            updateData.student_capacity = dto.student_capacity;
        }
        if (dto.gender_mode !== undefined) {
            updateData.gender_mode = dto.gender_mode;
        }

        await this.prisma.campus_sections.upsert({
            where: {
                campus_id_class_id_section_id: {
                    campus_id: campusId,
                    class_id: classId,
                    section_id: sectionId,
                },
            },
            update: updateData,
            create: {
                campus_id: campusId,
                class_id: classId,
                section_id: sectionId,
                is_active: isActive,
                student_capacity: dto.student_capacity ?? null,
                gender_mode: dto.gender_mode ?? SectionGenderMode.COED,
            },
        });

        const sectionLabel = `${cls.class_code}/${section.description}`;
        if (!existing) {
            await this.auditLogs.log({
                entity_type: 'CAMPUS',
                entity_id: String(campusId),
                action: 'UPDATED',
                section: 'school-setup',
                field: 'campus_section',
                new_value: sectionLabel,
                changed_by: changedBy ?? 'system',
                note: `Added section #${sectionId} (${sectionLabel}) to campus #${campusId} ("${campus.campus_name}"): is_active=${isActive}, capacity=${dto.student_capacity ?? 'unlimited'}, gender_mode=${dto.gender_mode ?? SectionGenderMode.COED}.`,
            });
        } else {
            const changes: string[] = [];
            if (existing.is_active !== isActive) {
                changes.push(`is_active ${existing.is_active} → ${isActive}`);
            }
            if (dto.student_capacity !== undefined && existing.student_capacity !== dto.student_capacity) {
                changes.push(`capacity ${existing.student_capacity ?? 'unlimited'} → ${dto.student_capacity ?? 'unlimited'}`);
            }
            if (dto.gender_mode !== undefined && existing.gender_mode !== dto.gender_mode) {
                changes.push(`gender_mode ${existing.gender_mode} → ${dto.gender_mode}`);
            }
            if (changes.length > 0) {
                await this.auditLogs.log({
                    entity_type: 'CAMPUS',
                    entity_id: String(campusId),
                    action: 'UPDATED',
                    section: 'school-setup',
                    field: 'campus_section',
                    changed_by: changedBy ?? 'system',
                    note: `Section #${sectionId} (${sectionLabel}) on campus #${campusId} ("${campus.campus_name}") updated: ${changes.join(', ')}.`,
                });
            }
        }

        return this.findOne(campusId);
    }

    async removeSectionFromCampus(campusId: number, classId: number, sectionId: number, changedBy?: string) {
        const [campus, cls, section] = await Promise.all([
            this.prisma.campuses.findUnique({ where: { id: campusId }, select: { campus_name: true } }),
            this.prisma.classes.findUnique({ where: { id: classId }, select: { class_code: true } }),
            this.prisma.sections.findUnique({ where: { id: sectionId }, select: { description: true } }),
        ]);

        const studentCount = await this.prisma.students.count({
            where: { campus_id: campusId, class_id: classId, section_id: sectionId, deleted_at: null },
        });

        if (studentCount > 0) {
            throw new BadRequestException(
                `Cannot remove section: ${studentCount} student(s) are currently assigned to it at this campus/class`,
            );
        }

        try {
            await this.prisma.campus_sections.delete({
                where: { campus_id_class_id_section_id: { campus_id: campusId, class_id: classId, section_id: sectionId } },
            });

            const sectionLabel = `${cls?.class_code ?? classId}/${section?.description ?? sectionId}`;
            await this.auditLogs.log({
                entity_type: 'CAMPUS',
                entity_id: String(campusId),
                action: 'UPDATED',
                section: 'school-setup',
                field: 'campus_section',
                old_value: sectionLabel,
                changed_by: changedBy ?? 'system',
                note: `Removed section #${sectionId} (${sectionLabel}) from campus #${campusId} ("${campus?.campus_name ?? '—'}").`,
            });

            return this.findOne(campusId);
        } catch (e: any) {
            if (e?.code === 'P2025') {
                throw new NotFoundException(`Section triplet not found`);
            }
            throw e;
        }
    }
}
