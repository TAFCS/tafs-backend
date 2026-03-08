import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateCampusDto } from './dto/create-campus.dto';
import { BulkUpdateCampusesDto } from './dto/bulk-update-campuses.dto';

@Injectable()
export class CampusesService {
    constructor(private readonly prisma: PrismaService) { }

    async findAll() {
        return this.prisma.campuses.findMany({
            orderBy: { campus_name: 'asc' },
        });
    }

    async findOne(id: number) {
        const campus = await this.prisma.campuses.findUnique({
            where: { id },
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
            dto.items.map((item) =>
                this.prisma.campuses.update({
                    where: { id: item.id },
                    data: {
                        ...(item.campus_code !== undefined && {
                            campus_code: item.campus_code,
                        }),
                        ...(item.campus_name !== undefined && {
                            campus_name: item.campus_name,
                        }),
                    },
                }),
            ),
        );

        if (!updated || updated.length !== dto.items.length) {
            throw new NotFoundException('One or more campuses not found');
        }

        return updated;
    }

    async delete(id: number) {
        // Check if there are any linked students or users to prevent cascade-like effects
        // since we want to avoid deleting a campus that is currently in use.
        const studentCount = await this.prisma.students.count({
            where: { campus_id: id },
        });

        if (studentCount > 0) {
            throw new BadRequestException('Cannot delete campus with linked students');
        }

        const userCount = await this.prisma.users.count({
            where: { campus_id: id },
        });

        if (userCount > 0) {
            throw new BadRequestException('Cannot delete campus with linked users');
        }

        return this.prisma.campuses.delete({
            where: { id },
        });
    }
}
