import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';

export class CreateEmployeeDto {
  user_id?: string;
  cnic?: string;
  join_date?: string;
  employment_type?: string;
  department_id?: number;
  designation_id?: number;
  reporting_manager_id?: number;
}

export class UpdateEmployeeDto {
  user_id?: string;
  cnic?: string;
  join_date?: string;
  employment_type?: string;
  department_id?: number;
  designation_id?: number;
  reporting_manager_id?: number;
}

@Injectable()
export class EmployeesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    return this.prisma.employee_profiles.findMany({
      include: {
        users: {
          select: { id: true, full_name: true, role: true, email: true, is_active: true }
        },
        departments: true,
        designations: true,
        reporting_manager: {
          include: { users: { select: { full_name: true } } }
        }
      }
    });
  }

  async findOne(id: number) {
    const employee = await this.prisma.employee_profiles.findUnique({
      where: { id },
      include: {
        users: {
          select: { id: true, full_name: true, role: true, email: true, is_active: true }
        },
        departments: true,
        designations: true,
        reporting_manager: {
          include: { users: { select: { full_name: true } } }
        }
      }
    });
    if (!employee) {
      throw new NotFoundException(`Employee profile with ID ${id} not found`);
    }
    return employee;
  }

  async create(dto: CreateEmployeeDto) {
    return this.prisma.employee_profiles.create({
      data: {
        user_id: dto.user_id || null,
        cnic: dto.cnic || null,
        join_date: dto.join_date ? new Date(dto.join_date) : null,
        employment_type: dto.employment_type || null,
        department_id: dto.department_id || null,
        designation_id: dto.designation_id || null,
        reporting_manager_id: dto.reporting_manager_id || null,
      },
      include: {
        users: { select: { full_name: true } },
        departments: true,
        designations: true,
      }
    });
  }

  async update(id: number, dto: UpdateEmployeeDto) {
    // Check if exists
    await this.findOne(id);

    return this.prisma.employee_profiles.update({
      where: { id },
      data: {
        user_id: dto.user_id !== undefined ? dto.user_id : undefined,
        cnic: dto.cnic !== undefined ? dto.cnic : undefined,
        join_date: dto.join_date !== undefined ? (dto.join_date ? new Date(dto.join_date) : null) : undefined,
        employment_type: dto.employment_type !== undefined ? dto.employment_type : undefined,
        department_id: dto.department_id !== undefined ? dto.department_id : undefined,
        designation_id: dto.designation_id !== undefined ? dto.designation_id : undefined,
        reporting_manager_id: dto.reporting_manager_id !== undefined ? dto.reporting_manager_id : undefined,
      },
      include: {
        users: { select: { full_name: true } },
        departments: true,
        designations: true,
      }
    });
  }

  async remove(id: number) {
    await this.findOne(id);
    return this.prisma.employee_profiles.delete({
      where: { id }
    });
  }

  async findUnlinkedUsers() {
    // Find all active staff users who do not have an employee profile linked
    return this.prisma.users.findMany({
      where: {
        is_active: true,
        employee_profile: null,
      },
      select: {
        id: true,
        full_name: true,
        email: true,
        role: true,
      }
    });
  }
}
