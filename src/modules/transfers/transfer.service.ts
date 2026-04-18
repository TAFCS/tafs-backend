import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.service';
import { renderToBuffer } from '@react-pdf/renderer';
import * as React from 'react';
import { TransferOrderPDF } from './TransferOrderPDF';

@Injectable()
export class TransferService {
  private readonly logger = new Logger(TransferService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}
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

  async getAvailableClasses(cc: number) {
    const student = await this.prisma.students.findUnique({
      where: { cc },
      include: { classes: { select: { description: true, class_code: true, academic_system: true } } },
    });

    const currentClass = student?.classes?.description;

    const all = await this.prisma.classes.findMany({
      orderBy: [{ academic_system: 'asc' }, { description: 'asc' }],
      select: { id: true, description: true, class_code: true, academic_system: true },
    });

    if (!currentClass) return [];

    const normalize = (s: string) => s.replace(/^Class\s+/i, '').trim().toUpperCase();
    const normalizedCurrent = normalize(currentClass);

    const mapping: Record<string, string[]> = {
      'SR I': ['VI'],
      'VI': ['SR I'],
      'SR II': ['VII'],
      'VII': ['SR II'],
      'SR III': ['VIII'],
      'VIII': ['SR III'],
      'O-I': ['IX'],
      'IX': ['O-I'],
      'O-II': ['X'],
      'O-III': ['X'],
      'X': ['O-II', 'O-III'],
    };

    const allowed = mapping[normalizedCurrent];

    if (!allowed) {
      return [];
    }

    return all.filter(c => allowed.includes(normalize(c.description)));
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

  async generateTransferPdf(cc: number, opts: {
    transfer_from?: string;
    transfer_to?: string;
    discipline?: string;
    remarks?: string;
    date_of_transfer?: string;
  }) {
    const data = await this.getTransferOrderData(cc);

    // Fetch student photo as buffer so it doesn't need CORS in the backend
    let photographUrl: string | null = null;
    if (data.photograph_url) {
      try {
        const { buffer, mime } = await this.storage.getFile(
          this.storage.extractKeyFromUrl(data.photograph_url),
        );
        const b64 = buffer.toString('base64');
        photographUrl = `data:${mime};base64,${b64}`;
      } catch (e) {
        this.logger.warn(`Could not embed photo for CC ${cc}`, e);
      }
    }

    const now = new Date();
    const months = ['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'];
    const days = ['SUNDAY','MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY'];

    const pdfData = {
      ...data,
      photograph_url: photographUrl,
      transfer_from: opts.transfer_from || data.academic_system || '',
      transfer_to: opts.transfer_to || '',
      discipline: opts.discipline || '',
      date_of_transfer: opts.date_of_transfer ||
        `${String(now.getDate()).padStart(2,'0')} ${months[now.getMonth()]} ${now.getFullYear()}`,
      remarks_footer: opts.remarks || '',
      day: data.day,
      date: data.date,
    };

    try {
      const element = React.createElement(TransferOrderPDF, { data: pdfData }) as any;
      const buffer = Buffer.from(await renderToBuffer(element));

      const key = `transfers/${cc}/transfer-order-${Date.now()}.pdf`;
      const url = await this.storage.upload(key, buffer, 'application/pdf');
      this.logger.log(`Transfer PDF uploaded for CC ${cc}: ${url}`);
      return { url };
    } catch (err: any) {
      this.logger.error(`Failed to generate/upload Transfer PDF for CC ${cc}`, err?.stack || err);
      throw new BadRequestException('Failed to generate PDF: ' + (err?.message || 'Unknown error'));
    }
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
      dob: student.dob ? (student.dob as any instanceof Date ? (student.dob as any).toISOString() : String(student.dob)) : null,
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
