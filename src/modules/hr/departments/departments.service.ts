import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';

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
  constructor(private readonly prisma: PrismaService) {}

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

  async create(dto: CreateDepartmentDto) {
    return this.prisma.departments.create({
      data: dto
    });
  }

  async update(id: number, dto: Partial<CreateDepartmentDto>) {
    await this.findOne(id);
    return this.prisma.departments.update({
      where: { id },
      data: dto
    });
  }

  async remove(id: number) {
    await this.findOne(id);
    return this.prisma.departments.delete({
      where: { id }
    });
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
