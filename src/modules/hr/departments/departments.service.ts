import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';

export class CreateDepartmentDto {
  name: string;
  description?: string;
}

export class CreateDesignationDto {
  title: string;
  description?: string;
}

@Injectable()
export class DepartmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async findAll() {
    return this.prisma.departments.findMany({
      include: { designations: true }
    });
  }

  async findOne(id: number) {
    const dept = await this.prisma.departments.findUnique({
      where: { id },
      include: { designations: true }
    });
    if (!dept) {
      throw new NotFoundException(`Department with ID ${id} not found`);
    }
    return dept;
  }

  async create(dto: CreateDepartmentDto, changedBy?: string) {
    const record = await this.prisma.departments.create({ data: dto });
    this.auditLogs.log({ entity_type: 'DEPARTMENT', entity_id: String(record.id), action: 'CREATED', section: 'hr', new_value: dto.name, changed_by: changedBy ?? 'system' });
    return record;
  }

  async update(id: number, dto: Partial<CreateDepartmentDto>, changedBy?: string) {
    const existing = await this.findOne(id);
    const record = await this.prisma.departments.update({ where: { id }, data: dto });
    this.auditLogs.log({ entity_type: 'DEPARTMENT', entity_id: String(id), action: 'UPDATED', section: 'hr', old_value: existing.name, new_value: dto.name, changed_by: changedBy ?? 'system' });
    return record;
  }

  async remove(id: number, changedBy?: string) {
    const existing = await this.findOne(id);
    const record = await this.prisma.departments.delete({ where: { id } });
    this.auditLogs.log({ entity_type: 'DEPARTMENT', entity_id: String(id), action: 'DELETED', section: 'hr', old_value: existing.name, changed_by: changedBy ?? 'system' });
    return record;
  }

  // Designations CRUD
  async createDesignation(departmentId: number, dto: CreateDesignationDto) {
    await this.findOne(departmentId);
    return this.prisma.designations.create({
      data: {
        department_id: departmentId,
        title: dto.title,
        description: dto.description
      }
    });
  }

  async updateDesignation(departmentId: number, designationId: number, dto: Partial<CreateDesignationDto>) {
    const des = await this.prisma.designations.findUnique({
      where: { id: designationId }
    });
    if (!des || des.department_id !== departmentId) {
      throw new NotFoundException(`Designation with ID ${designationId} not found in department ${departmentId}`);
    }
    return this.prisma.designations.update({
      where: { id: designationId },
      data: dto
    });
  }

  async removeDesignation(departmentId: number, designationId: number) {
    const des = await this.prisma.designations.findUnique({
      where: { id: designationId }
    });
    if (!des || des.department_id !== departmentId) {
      throw new NotFoundException(`Designation with ID ${designationId} not found in department ${departmentId}`);
    }
    return this.prisma.designations.delete({
      where: { id: designationId }
    });
  }
}
