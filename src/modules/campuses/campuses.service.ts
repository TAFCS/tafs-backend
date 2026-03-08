import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateCampusDto } from './dto/create-campus.dto';
import { BulkUpdateCampusesDto } from './dto/bulk-update-campuses.dto';

@Injectable()
export class CampusesService {
    constructor(private readonly prisma: PrismaService) { }

    private readonly campusClassesInclude = {
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
    };

    async findAll() {
        return this.prisma.campuses.findMany({
            orderBy: { campus_name: 'asc' },
            include: this.campusClassesInclude,
        });
    }

    async findOne(id: number) {
        const campus = await this.prisma.campuses.findUnique({
            where: { id },
            include: this.campusClassesInclude,
        });
        if (!campus) throw new NotFoundException('Campus not found');
        return campus;
    }

    async create(dto: CreateCampusDto) {
        return this.prisma.campuses.create({
            data: {
                campus_code: dto.campus_code,
                campus_name: dto.campus_name,
            },
        });
    }

    async bulkUpdate(dto: BulkUpdateCampusesDto) {
        if (!dto.items || dto.items.length === 0) {
            return [];
        }

        const updated = await this.prisma.$transaction(
            dto.items.map((item) => {
                if (item.id) {
                    // Update existing
                    return this.prisma.campuses.update({
                        where: { id: item.id },
                        data: {
                            ...(item.campus_code !== undefined && {
                                campus_code: item.campus_code,
                            }),
                            ...(item.campus_name !== undefined && {
                                campus_name: item.campus_name,
                            }),
                        },
                    });
                } else {
                    // Create new
                    return this.prisma.campuses.create({
                        data: {
                            campus_code: item.campus_code || '',
                            campus_name: item.campus_name || '',
                        },
                    });
                }
            }),
        );

        return updated;
    }

    async findAllClasses() {
        return this.prisma.classes.findMany({
            orderBy: { description: 'asc' },
        });
    }

    async delete(id: number) {
        // Use a transaction to safely unlink related records and delete the campus
        return this.prisma.$transaction(async (tx) => {
            // 1. Unlink Students
            await tx.students.updateMany({
                where: { campus_id: id },
                data: { campus_id: null },
            });

            // 2. Unlink Users/Staff
            await tx.users.updateMany({
                where: { campus_id: id },
                data: { campus_id: null },
            });

            // 3. Unlink Class Fee Schedules
            await tx.class_fee_schedule.updateMany({
                where: { campus_id: id },
                data: { campus_id: null },
            });

            // 4. Delete Junction Records (Campus Classes assignments)
            await tx.campus_classes.deleteMany({
                where: { campus_id: id },
            });

            // 5. Finally, delete the campus itself
            return tx.campuses.delete({
                where: { id },
            });
        });
    }

    // ─── Campus Classes ───────────────────────────────────────────────────────

    async addClassToCampus(campusId: number, classId: number) {
        // Verify both campus and class exist
        const [campus, cls] = await Promise.all([
            this.prisma.campuses.findUnique({ where: { id: campusId }, select: { id: true } }),
            this.prisma.classes.findUnique({ where: { id: classId }, select: { id: true } }),
        ]);
        if (!campus) throw new NotFoundException(`Campus #${campusId} not found`);
        if (!cls) throw new NotFoundException(`Class #${classId} not found`);

        // Upsert: re-activates a previously deactivated link instead of throwing a duplicate error
        const record = await this.prisma.campus_classes.upsert({
            where: { campus_id_class_id: { campus_id: campusId, class_id: classId } },
            update: { is_active: true },
            create: { campus_id: campusId, class_id: classId, is_active: true },
            include: { classes: { select: { id: true, description: true, class_code: true, academic_system: true } } },
        });
        return record;
    }

    async updateCampusClass(campusId: number, classId: number, isActive: boolean) {
        try {
            return await this.prisma.campus_classes.update({
                where: { campus_id_class_id: { campus_id: campusId, class_id: classId } },
                data: { is_active: isActive },
                include: { classes: { select: { id: true, description: true, class_code: true, academic_system: true } } },
            });
        } catch (e: any) {
            if (e?.code === 'P2025') {
                throw new NotFoundException(`Class #${classId} is not offered at campus #${campusId}`);
            }
            throw e;
        }
    }

    async removeClassFromCampus(campusId: number, classId: number) {
        // Check if any active students in this campus are assigned to this class
        const studentCount = await this.prisma.students.count({
            where: { campus_id: campusId, class_id: classId, deleted_at: null },
        });
        if (studentCount > 0) {
            throw new BadRequestException(
                `Cannot remove class #${classId}: ${studentCount} student(s) are currently assigned to it at this campus`,
            );
        }

        try {
            await this.prisma.campus_classes.delete({
                where: { campus_id_class_id: { campus_id: campusId, class_id: classId } },
            });
        } catch (e: any) {
            if (e?.code === 'P2025') {
                throw new NotFoundException(`Class #${classId} is not offered at campus #${campusId}`);
            }
            throw e;
        }
    }
}
