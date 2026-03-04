import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { GetStudentsDto } from './dto/get-students.dto';
import { calculateOffset } from '../../utils/pagination.util';
import { createPaginationMeta } from '../../utils/serializer.util';
import { Prisma } from '@prisma/client';

@Injectable()
export class StudentsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: GetStudentsDto) {
    const { page = 1, limit = 10, search, campus_id, status } = query;
    const offset = calculateOffset(page, limit);

    // Build modern dynamic where clause
    const where: Prisma.studentsWhereInput = {
      deleted_at: null,
    };

    if (search) {
      where.OR = [
        { first_name: { contains: search, mode: 'insensitive' } },
        { last_name: { contains: search, mode: 'insensitive' } },
        { gr_number: { contains: search, mode: 'insensitive' } },
        { cc_number: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (campus_id) {
      where.campus_id = campus_id;
    }

    if (status) {
      where.status = status;
    }

    // Execute count and data queries concurrently
    const [total, studentsData] = await Promise.all([
      this.prisma.students.count({ where }),
      this.prisma.students.findMany({
        where,
        skip: offset,
        take: limit,
        orderBy: { created_at: 'desc' },
        select: {
          id: true,
          first_name: true,
          last_name: true,
          gr_number: true,
          cc_number: true,
          status: true,
          dob: true, // Toggleable
          // Default columns relationships
          campuses: {
            select: {
              campus_name: true,
            },
          },
          // Grade & Section (fetching the most recent admission context)
          student_admissions: {
            orderBy: { application_date: 'desc' },
            take: 1,
            select: {
              requested_grade: true,
              academic_system: true,
            },
          },
          // Primary Guardian relationship
          student_guardians: {
            where: { is_primary_contact: true },
            take: 1,
            select: {
              guardians: {
                select: {
                  full_name: true,
                  whatsapp_number: true,
                  cnic: true, // Toggleable
                },
              },
            },
          },
          // Toggleable Columns relationships
          families: {
            select: {
              id: true,
              household_name: true,
              primary_address: true,
            },
          },
        },
      }),
    ]);

    // Map and flatten response structure
    const mappedItems = studentsData.map((s) => {
      const primaryGuardian =
        s.student_guardians.length > 0 ? s.student_guardians[0].guardians : null;
      const latestAdmission =
        s.student_admissions.length > 0 ? s.student_admissions[0] : null;

      return {
        // --- Default Columns ---
        id: s.id,
        student_full_name: `${s.first_name} ${s.last_name}`.trim(),
        gr_number: s.gr_number,
        cc_number: s.cc_number,
        campus: s.campuses?.campus_name,
        grade_and_section: latestAdmission ? `${latestAdmission.requested_grade}` : null,
        primary_guardian_name: primaryGuardian?.full_name,
        whatsapp_number: primaryGuardian?.whatsapp_number,
        enrollment_status: s.status,
        financial_status_badge: 'CLEARED', // TODO: Implement via Finance Ledger later

        // --- Toggleable Columns ---
        family_id: s.families?.id,
        household_name: s.families?.household_name,
        total_outstanding_balance: 0, // TODO: Implement via Finance Ledger
        advance_credit_balance: 0, // TODO: Implement via Finance Ledger
        primary_guardian_cnic: primaryGuardian?.cnic,
        date_of_birth: s.dob,
        registration_number: s.cc_number, // Fallback mapping for now
        house_and_color: null, // Legacy data unsupported
        residential_address: s.families?.primary_address,
      };
    });

    const meta = createPaginationMeta(page, limit, total);

    return { items: mappedItems, meta };
  }
}