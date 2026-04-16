import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class TransferService {
  constructor(private readonly prisma: PrismaService) {}

  async searchStudents(q: string) {
    if (!q?.trim()) return [];
    const isNumeric = /^\d+$/.test(q.trim());
    const students = await this.prisma.students.findMany({
      where: {
        deleted_at: null,
        OR: [
          ...(isNumeric ? [{ cc: Number(q) }] : []),
          { full_name: { contains: q, mode: 'insensitive' as const } },
          { gr_number: { contains: q, mode: 'insensitive' as const } },
        ],
      },
      take: 20,
      select: {
        cc: true,
        full_name: true,
        gr_number: true,
        photograph_url: true,
        photo_blue_bg_url: true,
        campuses: { select: { campus_name: true, campus_code: true } },
        classes: { select: { description: true, academic_system: true } },
        sections: { select: { description: true } },
      },
      orderBy: { full_name: 'asc' },
    });

    return students.map((s) => ({
      cc: s.cc,
      full_name: s.full_name,
      gr_number: s.gr_number,
      campus_name: s.campuses?.campus_name,
      campus_number: s.campuses?.campus_code,
      class_name: s.classes?.description,
      academic_system: s.classes?.academic_system,
      section_name: s.sections?.description,
      photograph_url: s.photograph_url || s.photo_blue_bg_url,
    }));
  }

  async getAvailableClasses() {
    return this.prisma.classes.findMany({
      orderBy: [{ academic_system: 'asc' }, { description: 'asc' }],
      select: { id: true, description: true, class_code: true, academic_system: true },
    });
  }

  async executeTransfer(cc: number, dto: { to_class_id: number; discipline?: string; remarks?: string }) {
    const student = await this.prisma.students.findUnique({
      where: { cc },
      include: { classes: { select: { description: true, academic_system: true } } },
    });
    if (!student) throw new NotFoundException(`Student with CC #${cc} not found`);
    if (student.deleted_at) throw new BadRequestException('Cannot transfer a deleted student');

    const toClass = await this.prisma.classes.findUnique({
      where: { id: dto.to_class_id },
      select: { description: true, academic_system: true },
    });
    if (!toClass) throw new BadRequestException(`Target class #${dto.to_class_id} not found`);

    // Increment academic year
    const currentYear = student.academic_year;
    let nextYear = currentYear || '';
    const rangeMatch = currentYear?.match(/^(\d{4})-(\d{4})$/);
    if (rangeMatch) {
      nextYear = `${Number(rangeMatch[1]) + 1}-${Number(rangeMatch[2]) + 1}`;
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.students.update({
        where: { cc },
        data: {
          class_id: dto.to_class_id,
          academic_year: nextYear || currentYear || undefined,
        },
      });
      await tx.student_admissions.create({
        data: {
          student_id: cc,
          academic_system: toClass.academic_system,
          requested_grade: toClass.description,
          academic_year: nextYear || currentYear || undefined,
        },
      });
    });

    // Re-fetch the updated transfer order data for the PDF
    return this.getTransferOrderData(cc);
  }

  async getTransferOrderData(cc: number) {
    const student = await this.prisma.students.findUnique({
      where: { cc },
      include: {
        campuses: true,
        classes: true,
        sections: true,
        families: {
          include: {
            students: {
              where: { gr_number: { not: null } },
              select: { cc: true, gr_number: true },
            },
          },
        },
        student_admissions: {
          orderBy: { application_date: 'desc' },
          take: 1,
        },
        student_guardians: {
          include: {
            guardians: true,
          },
        },
      },
    });

    if (!student) {
      throw new NotFoundException(`Student with CC #${cc} not found`);
    }

    const fatherLink = student.student_guardians.find(
      (g) => g.relationship?.toLowerCase() === 'father',
    );
    const motherLink = student.student_guardians.find(
      (g) => g.relationship?.toLowerCase() === 'mother',
    );
    const emergencyContact = student.student_guardians.find(
      (g) => g.is_emergency_contact,
    );

    // Scholastic year
    const academicYear =
      student.academic_year || student.student_admissions[0]?.academic_year;
    let scholasticYear = '';
    if (academicYear) {
      const parts = academicYear.split('-');
      scholasticYear = parts.length === 2 ? `${parts[0]}-${parts[1]}` : academicYear;
    }

    // Auto day + date
    const now = new Date();
    const dayNames = [
      'SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY',
      'THURSDAY', 'FRIDAY', 'SATURDAY',
    ];
    const monthNames = [
      'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
      'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER',
    ];
    const currentDay = dayNames[now.getDay()];
    const currentDate = `${monthNames[now.getMonth()]} ${now.getDate().toString().padStart(2, '0')}, ${now.getFullYear()}`;

    // Segment head based on class academic_system
    let segmentHead = '';
    if (student.classes?.academic_system === 'CAMBRIDGE') {
      const classCode = student.classes.class_code.toUpperCase();
      segmentHead = classCode.includes('JUNIOR') ? 'JUNIOR CAMBRIDGE' : 'CAMBRIDGE';
    } else {
      segmentHead = student.classes?.academic_system || '';
    }

    // Address resolution (same priority as admission order)
    let address = '';
    for (const sg of student.student_guardians) {
      if (sg.guardians?.mailing_address) {
        address = sg.guardians.mailing_address;
        break;
      }
    }
    if (!address) {
      address = student.families?.primary_address || '';
    }
    if (!address) {
      for (const sg of student.student_guardians) {
        if (sg.guardians) {
          const g = sg.guardians;
          const parts = [
            g.house_appt_name,
            g.house_appt_number,
            g.area_block,
            g.city,
            g.province,
            g.country,
          ].filter(Boolean);
          if (parts.length > 0) {
            address = parts.join(', ');
            break;
          }
        }
      }
    }

    const formatPhone = (phone: string | null | undefined) => {
      if (!phone) return '';
      let cleaned = phone.toString().replace(/\D/g, '');
      if (!cleaned) return '';
      if (cleaned.startsWith('0')) cleaned = cleaned.substring(1);
      if (cleaned.startsWith('92')) return `+${cleaned}`;
      return `+92${cleaned}`;
    };

    return {
      cc: student.cc,
      gr_number: student.gr_number,
      reg_number: student.cc.toString(),
      day: currentDay,
      date: currentDate,
      full_name: student.full_name,
      dob: student.dob,
      gender: student.gender,
      scholastic_year: scholasticYear,
      academic_year: academicYear,
      campus_name: student.campuses?.campus_name,
      campus_number: student.campuses?.campus_code,
      class_name: student.classes?.description,
      section_name: student.sections?.description,
      academic_system: student.classes?.academic_system,
      segment_head: segmentHead,
      address: address,
      home_phone: student.families?.home_phone,
      father_name: fatherLink?.guardians?.full_name,
      father_cell: formatPhone(fatherLink?.guardians?.primary_phone),
      mother_cell: formatPhone(motherLink?.guardians?.primary_phone),
      nearest_name: emergencyContact?.guardians?.full_name || '',
      nearest_phone: formatPhone(emergencyContact?.guardians?.primary_phone),
      nearest_relationship: emergencyContact?.relationship || '',
      email: student.email || student.families?.email,
      fax: fatherLink?.guardians?.fax_number,
      photograph_url: student.photograph_url || student.photo_blue_bg_url,
    };
  }
}
