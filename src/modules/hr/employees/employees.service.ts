import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';

export class ClassSectionAssignmentDto {
  class_id: number;
  section_id: number;
}

export class CreateEmployeeDto {
  user_id?: string;
  cnic?: string;
  join_date?: string;
  employment_type?: string;
  department_id?: number;
  designation_id?: number;
  reporting_manager_id?: number;
  employee_code?: string;
  full_name?: string;
  father_name?: string;
  mother_name?: string;
  date_of_birth?: string;
  address?: string;
  personal_phone?: string;
  personal_email?: string;
  job_title?: string;
  job_description?: string;
  notes?: string;
  reporting_time?: string;
  leaving_time?: string;
  late_relaxation_minutes?: number;
  monthly_pay?: number;
  staff_type_id?: number;
  campus_id?: number;
  days_per_week?: number;
  class_section_assignments?: ClassSectionAssignmentDto[];
}

export class UpdateEmployeeDto extends CreateEmployeeDto {}

const includeRelations = {
  users: {
    select: { id: true, full_name: true, role: true, email: true, is_active: true }
  },
  departments: true,
  designations: true,
  staff_types: true,
  campuses: true,
  reporting_manager: {
    include: { users: { select: { full_name: true } } }
  },
  employee_class_section_assignments: {
    include: { classes: true, sections: true }
  }
};

const toTime = (value?: string) => (value ? new Date(`1970-01-01T${value}:00Z`) : null);

@Injectable()
export class EmployeesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    return this.prisma.employee_profiles.findMany({
      include: includeRelations
    });
  }

  async findOne(id: number) {
    const employee = await this.prisma.employee_profiles.findUnique({
      where: { id },
      include: includeRelations
    });
    if (!employee) {
      throw new NotFoundException(`Employee profile with ID ${id} not found`);
    }
    return employee;
  }

  async create(dto: CreateEmployeeDto) {
    const { class_section_assignments, ...rest } = dto;
    return this.prisma.employee_profiles.create({
      data: {
        user_id: rest.user_id || null,
        cnic: rest.cnic || null,
        join_date: rest.join_date ? new Date(rest.join_date) : null,
        employment_type: rest.employment_type || null,
        department_id: rest.department_id || null,
        designation_id: rest.designation_id || null,
        reporting_manager_id: rest.reporting_manager_id || null,
        employee_code: rest.employee_code || null,
        full_name: rest.full_name || null,
        father_name: rest.father_name || null,
        mother_name: rest.mother_name || null,
        date_of_birth: rest.date_of_birth ? new Date(rest.date_of_birth) : null,
        address: rest.address || null,
        personal_phone: rest.personal_phone || null,
        personal_email: rest.personal_email || null,
        job_title: rest.job_title || null,
        job_description: rest.job_description || null,
        notes: rest.notes || null,
        reporting_time: toTime(rest.reporting_time),
        leaving_time: toTime(rest.leaving_time),
        late_relaxation_minutes: rest.late_relaxation_minutes ?? null,
        monthly_pay: rest.monthly_pay ?? null,
        staff_type_id: rest.staff_type_id || null,
        campus_id: rest.campus_id || null,
        days_per_week: rest.days_per_week ?? null,
        employee_class_section_assignments: class_section_assignments?.length
          ? {
              create: class_section_assignments.map((a) => ({
                class_id: a.class_id,
                section_id: a.section_id
              }))
            }
          : undefined
      },
      include: includeRelations
    });
  }

  async update(id: number, dto: UpdateEmployeeDto) {
    await this.findOne(id);
    const { class_section_assignments, ...rest } = dto;

    return this.prisma.$transaction(async (tx) => {
      if (class_section_assignments !== undefined) {
        await tx.employee_class_section_assignments.deleteMany({ where: { employee_id: id } });
        if (class_section_assignments.length) {
          await tx.employee_class_section_assignments.createMany({
            data: class_section_assignments.map((a) => ({
              employee_id: id,
              class_id: a.class_id,
              section_id: a.section_id
            }))
          });
        }
      }

      return tx.employee_profiles.update({
        where: { id },
        data: {
          user_id: rest.user_id !== undefined ? rest.user_id : undefined,
          cnic: rest.cnic !== undefined ? rest.cnic : undefined,
          join_date: rest.join_date !== undefined ? (rest.join_date ? new Date(rest.join_date) : null) : undefined,
          employment_type: rest.employment_type !== undefined ? rest.employment_type : undefined,
          department_id: rest.department_id !== undefined ? rest.department_id : undefined,
          designation_id: rest.designation_id !== undefined ? rest.designation_id : undefined,
          reporting_manager_id: rest.reporting_manager_id !== undefined ? rest.reporting_manager_id : undefined,
          employee_code: rest.employee_code !== undefined ? rest.employee_code : undefined,
          full_name: rest.full_name !== undefined ? rest.full_name : undefined,
          father_name: rest.father_name !== undefined ? rest.father_name : undefined,
          mother_name: rest.mother_name !== undefined ? rest.mother_name : undefined,
          date_of_birth:
            rest.date_of_birth !== undefined ? (rest.date_of_birth ? new Date(rest.date_of_birth) : null) : undefined,
          address: rest.address !== undefined ? rest.address : undefined,
          personal_phone: rest.personal_phone !== undefined ? rest.personal_phone : undefined,
          personal_email: rest.personal_email !== undefined ? rest.personal_email : undefined,
          job_title: rest.job_title !== undefined ? rest.job_title : undefined,
          job_description: rest.job_description !== undefined ? rest.job_description : undefined,
          notes: rest.notes !== undefined ? rest.notes : undefined,
          reporting_time: rest.reporting_time !== undefined ? toTime(rest.reporting_time) : undefined,
          leaving_time: rest.leaving_time !== undefined ? toTime(rest.leaving_time) : undefined,
          late_relaxation_minutes: rest.late_relaxation_minutes !== undefined ? rest.late_relaxation_minutes : undefined,
          monthly_pay: rest.monthly_pay !== undefined ? rest.monthly_pay : undefined,
          staff_type_id: rest.staff_type_id !== undefined ? rest.staff_type_id : undefined,
          campus_id: rest.campus_id !== undefined ? rest.campus_id : undefined,
          days_per_week: rest.days_per_week !== undefined ? rest.days_per_week : undefined
        },
        include: includeRelations
      });
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
