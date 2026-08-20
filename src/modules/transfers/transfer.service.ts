import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.service';
import { renderToBuffer } from '@react-pdf/renderer';
import * as React from 'react';
import { TransferOrderPDF } from './TransferOrderPDF';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { StudentAllocationService } from '../student-allocation/student-allocation.service';
import { StudentStatus } from '../../constants/student-status.constant';
import { ProgressionHistoryService } from '../students/progression-history.service';
import { resolveCampusGrPrefix, computeNextGrNumber } from '../../common/utils/gr-number.util';

@Injectable()
export class TransferService {
  private readonly logger = new Logger(TransferService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly auditLogs: AuditLogsService,
    private readonly allocation: StudentAllocationService,
    private readonly progressionHistory: ProgressionHistoryService,
  ) {}
  async searchStudents(q: string) {
    if (!q?.trim()) return [];
    const queryStr = q.trim();
    const queryLower = queryStr.toLowerCase();
    const isNumeric = /^\d+$/.test(queryStr);

    const ccRanges: any[] = [];
    if (isNumeric) {
      const numVal = Number(queryStr);
      let multiplier = 1;
      for (let i = 0; i < 6; i++) {
        const gte = numVal * multiplier;
        const lte = (numVal + 1) * multiplier - 1;
        ccRanges.push({ cc: { gte, lte } });
        multiplier *= 10;
      }
    }

    const students = await this.prisma.students.findMany({
      where: {
        deleted_at: null,
        OR: [
          ...(isNumeric ? ccRanges : []),
          { full_name: { contains: queryStr, mode: 'insensitive' as const } },
          { gr_number: { contains: queryStr, mode: 'insensitive' as const } },
        ],
      },
      take: 150,
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
    });

    const mapped = students.map((s) => {
      const ccStr = s.cc.toString();
      const grStr = (s.gr_number || '').toLowerCase();
      const nameStr = (s.full_name || '').toLowerCase();

      let score = 0;

      // Exact matches
      if (isNumeric && s.cc === Number(queryStr)) {
        score += 1000;
      }
      if (grStr === queryLower) {
        score += 900;
      }
      if (nameStr === queryLower) {
        score += 800;
      }

      // Starts-with matches
      if (isNumeric && ccStr.startsWith(queryStr)) {
        score += 500;
      }
      if (grStr.startsWith(queryLower)) {
        score += 400;
      }
      if (nameStr.startsWith(queryLower)) {
        score += 300;
      }

      // Contains matches
      if (grStr.includes(queryLower)) {
        score += 100;
      }
      if (nameStr.includes(queryLower)) {
        score += 50;
      }

      return {
        student: s,
        score,
      };
    });

    // Sort by score descending, then by name ascending
    mapped.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return (a.student.full_name || '').localeCompare(b.student.full_name || '');
    });

    const top25 = mapped.slice(0, 25).map((item) => item.student);

    return top25.map((s) => ({
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

  /**
   * Preview what GR the student would get if transferred to the given campus.
   * Returns null when the GR would not change.
   */
  async previewTransferGr(cc: number, toCampusId: number, toClassId?: number): Promise<{ new_gr: string; old_gr: string | null; dest_prefix: string; source_prefix: string } | null> {
    const student = await this.prisma.students.findUnique({
      where: { cc },
      select: { campus_id: true, gr_number: true },
    });
    if (!student || !student.campus_id) return null;
    if (toCampusId === student.campus_id) return null;

    const destPrefix = await resolveCampusGrPrefix(this.prisma, toCampusId);
    const sourcePrefix = await resolveCampusGrPrefix(this.prisma, student.campus_id);
    if (destPrefix === sourcePrefix) return null;

    let isALevel = false;
    if (toClassId) {
      const cls = await this.prisma.classes.findUnique({ where: { id: toClassId }, select: { academic_system: true } });
      isALevel = cls?.academic_system === 'A-Level';
    }

    const newGr = await computeNextGrNumber(this.prisma, toCampusId, isALevel);
    return {
      new_gr: newGr,
      old_gr: student.gr_number,
      dest_prefix: destPrefix,
      source_prefix: sourcePrefix,
    };
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

    const normalize = (s: string) => {
      if (!s) return '';
      // 1. Clean up: remove "Class " prefix, replace dots/hyphens with space, collapse spaces
      const clean = s
        .replace(/^Class\s+/i, '')
        .replace(/[.\-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toUpperCase();

      // 2. Base keys using spaces for consistency (e.g., 'SR I', 'O I')
      const baseKeys = [
        'SR III', 'SR II', 'SR I',
        'O III', 'O II', 'O I',
        'VIII', 'VII', 'IX', 'VI', 'X'
      ];

      // 3. Match base key
      for (const k of baseKeys) {
        if (clean === k || clean.startsWith(k + ' ')) {
          return k;
        }
      }
      return clean;
    };

    const mapping: Record<string, string[]> = {
      'SR I': ['VI', 'VII'],
      'VI': ['SR I', 'SR II'],
      'SR II': ['VII', 'VIII'],
      'VII': ['SR II', 'SR III'],
      'SR III': ['VIII', 'IX'],
      'VIII': ['SR III', 'O I'],
      'O I': ['IX', 'X'],
      'IX': ['O I', 'O II'],
      'O II': ['X'],
      'O III': ['X'],
      'X': ['O II', 'O III'],
    };

    const normalizedCurrent = normalize(currentClass);
    const allowed = mapping[normalizedCurrent] || [];

    // Filter all classes to find ones that match the allowed normalized descriptions
    return all.filter(c => allowed.includes(normalize(c.description)));
  }

  async executeTransfer(cc: number, dto: { to_class_id: number; to_campus_id?: number; to_section_id?: number; discipline?: string; remarks?: string; target_academic_year?: string }, changedBy?: string) {
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

    if (dto.to_campus_id) {
      const targetCampus = await this.prisma.campuses.findUnique({
        where: { id: dto.to_campus_id },
      });
      if (!targetCampus) throw new BadRequestException(`Target campus #${dto.to_campus_id} not found`);
    }

    // Increment academic year or use provided
    const currentYear = student.academic_year;
    let nextYear = currentYear || '';
    if (dto.target_academic_year?.trim()) {
      nextYear = dto.target_academic_year.trim();
    } else {
      const rangeMatch = currentYear?.match(/^(\d{4})-(\d{4})$/);
      if (rangeMatch) {
        nextYear = `${Number(rangeMatch[1]) + 1}-${Number(rangeMatch[2]) + 1}`;
      }
    }

    // Auto-assign new GR when transferring between campuses with different GR prefixes
    let newGrNumber: string | undefined;
    if (
      dto.to_campus_id &&
      student.campus_id &&
      dto.to_campus_id !== student.campus_id
    ) {
      const destPrefix = await resolveCampusGrPrefix(this.prisma, dto.to_campus_id);
      const sourcePrefix = await resolveCampusGrPrefix(this.prisma, student.campus_id);
      if (destPrefix !== sourcePrefix) {
        const isALevel = toClass.academic_system === 'A-Level';
        newGrNumber = await computeNextGrNumber(this.prisma, dto.to_campus_id, isALevel);
      }
    }

    await this.prisma.$transaction(async (tx) => {
      const nextCampusId = dto.to_campus_id ?? student.campus_id;
      const nextClassId = dto.to_class_id;
      const nextSectionId =
        dto.to_section_id !== undefined ? dto.to_section_id : student.section_id;

      if (
        this.allocation.shouldValidatePlacement({
          campusId: nextCampusId,
          classId: nextClassId,
          sectionId: nextSectionId,
        })
      ) {
        await this.allocation.assertPlacementAllowed(
          {
            campusId: nextCampusId!,
            classId: nextClassId,
            sectionId: nextSectionId!,
          },
          {
            studentCc: cc,
            gender: student.gender,
            countsTowardCapacity: student.status === StudentStatus.ENROLLED,
          },
          tx,
        );
      }

      if (newGrNumber) {
        const duplicate = await tx.students.findFirst({
          where: {
            gr_number: newGrNumber,
            campus_id: dto.to_campus_id,
            deleted_at: null,
            cc: { not: cc },
          },
          select: { cc: true },
        });
        if (duplicate) {
          throw new BadRequestException(
            `GR ${newGrNumber} already exists on destination campus (CC #${duplicate.cc})`,
          );
        }
      }

      await tx.students.update({
        where: { cc },
        data: {
          class_id: dto.to_class_id,
          campus_id: dto.to_campus_id || undefined,
          section_id: dto.to_section_id !== undefined ? dto.to_section_id : undefined,
          academic_year: nextYear || currentYear || undefined,
          ...(newGrNumber ? { gr_number: newGrNumber } : {}),
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
      await this.progressionHistory.recordProgressionChange(tx, {
        studentCc: cc,
        campusId: dto.to_campus_id ?? student.campus_id,
        classId: dto.to_class_id,
        sectionId: dto.to_section_id ?? student.section_id,
        houseId: student.house_id,
        academicYear: nextYear || currentYear || null,
        grNumber: newGrNumber ?? student.gr_number,
        changeType: 'TRANSFERRED',
        changedBy: changedBy || null,
        notes: dto.remarks || null,
      });
    });

    // Log the transfer
    const fromClass = student.classes?.description || 'Unknown';
    const toClassName = toClass.description;
    let note = `Transferred from ${fromClass} to ${toClassName}`;
    if (nextYear && nextYear !== currentYear) note += ` (AY ${nextYear})`;
    if (newGrNumber) note += `. GR ${student.gr_number ?? '—'} → ${newGrNumber}`;
    if (dto.remarks) note += `. Remarks: ${dto.remarks}`;

    await this.auditLogs.log({
      entity_type: 'TRANSFER',
      entity_id: String(cc),
      action: 'CREATED',
      field: 'class',
      old_value: fromClass,
      new_value: toClassName,
      changed_by: changedBy || 'system',
      student_id: cc,
      note,
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
    class_name?: string;
    section_name?: string;
    academic_year?: string;
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

    let orderDay = data.day;
    let orderDate = data.date;
    if (opts.date_of_transfer) {
      try {
        const d = new Date(opts.date_of_transfer);
        if (!isNaN(d.getTime())) {
          orderDay = days[d.getDay()];
          orderDate = `${months[d.getMonth()]} ${String(d.getDate()).padStart(2, '0')}, ${d.getFullYear()}`;
        }
      } catch {}
    }

    const pdfData = {
      ...data,
      photograph_url: photographUrl,
      transfer_from: opts.transfer_from || data.academic_system || '',
      transfer_to: opts.transfer_to || '',
      discipline: opts.discipline || '',
      date_of_transfer: opts.date_of_transfer ||
        `${String(now.getDate()).padStart(2,'0')} ${months[now.getMonth()]} ${now.getFullYear()}`,
      remarks_footer: opts.remarks || '',
      class_name: opts.class_name || data.class_name,
      section_name: opts.section_name !== undefined ? opts.section_name : data.section_name,
      scholastic_year: opts.academic_year || data.scholastic_year,
      academic_year: opts.academic_year || data.academic_year,
      day: orderDay,
      date: orderDate,
    };

    try {
      const element = React.createElement(TransferOrderPDF, { data: pdfData }) as any;
      const buffer = Buffer.from(await renderToBuffer(element));

      const key = `transfers/${cc}/transfer-order-${Date.now()}.pdf`;
      const url = await this.storage.upload(key, buffer, 'application/pdf');
      this.logger.log(`Transfer PDF uploaded for CC ${cc}: ${url}`);

      // Save PDF URL to matching student_admissions record if possible
      const targetGrade = opts.class_name || opts.transfer_to || data.class_name;
      const targetYear = opts.academic_year || data.academic_year;
      if (targetGrade) {
        const matchingAdmission = await this.prisma.student_admissions.findFirst({
          where: {
            student_id: cc,
            requested_grade: targetGrade,
            academic_year: targetYear || undefined,
          },
          orderBy: { application_date: 'desc' },
        });
        if (matchingAdmission) {
          await this.prisma.student_admissions.update({
            where: { id: matchingAdmission.id },
            data: { transfer_order_url: url },
          });
        }
      }

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
          take: 5,
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
      campus_id: student.campus_id,
      class_name: student.classes?.description,
      section_name: student.sections?.description,
      section_id: student.section_id,
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
      admissions: student.student_admissions || [],
    };
  }
}
