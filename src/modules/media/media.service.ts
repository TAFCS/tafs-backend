import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  mimeForExtension,
  parseCcFilename,
  photoContentHash,
  studentPhotoKey,
  urlHasContentHash,
} from './student-photo-key.util';

/** Per-file outcome of a bulk student photo check or upload (TAFSD-483). */
export type BulkPhotoStatus =
  | 'ready'            // preview: will be uploaded
  | 'uploaded'         // upload: stored, now the current photo
  | 'already_uploaded' // this exact image is already in the student's history
  | 'invalid_name'     // filename is not "<cc>.jpg|jpeg|png"
  | 'not_found'        // no student with that CC in the caller's scope
  | 'duplicate_cc'     // the same CC appears more than once in this batch
  | 'error';

export interface BulkPhotoRow {
  file: string;
  cc: number | null;
  status: BulkPhotoStatus;
  message?: string;
  student?: {
    full_name: string;
    gr_number: string | null;
    class_name: string | null;
    section_name: string | null;
    current_photo_url: string | null;
  };
  url?: string;
}

@Injectable()
export class MediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async uploadStudentPhoto(
    cc: number,
    file: Express.Multer.File,
    type: 'standard' | 'blue_bg',
    isTemp = false,
    uploadedBy = 'system',
  ) {
    const student = await this.prisma.students.findUnique({ where: { cc } });
    if (!student) throw new NotFoundException(`Student with CC ${cc} not found`);

    const extension = file.originalname.split('.').pop() || 'jpg';
    const key = studentPhotoKey(cc, type, extension, photoContentHash(file.buffer));

    const url = await this.storage.upload(key, file.buffer, file.mimetype);

    if (!isTemp) {
      const field = type === 'blue_bg' ? 'photo_blue_bg_url' : 'photograph_url';
      
      await this.prisma.students.update({
        where: { cc },
        data: { [field]: url },
      });

      if (type === 'standard') {
        await this.prisma.student_photo_history.create({
          data: {
            student_id: cc,
            url,
            photo_type: type,
            uploaded_by: uploadedBy,
            uploaded_at: new Date(),
          },
        });
      }

      const label = type === 'blue_bg' ? 'blue-background photo' : 'standard photo';
      await this.auditLogs.log({
        entity_type: 'STUDENT',
        entity_id: String(cc),
        action: 'UPDATED',
        field,
        changed_by: uploadedBy,
        student_id: cc,
        note: `Uploaded student ${label} for CC ${cc} (${student.full_name || 'N/A'}).`,
      });
    }

    return { url };
  }

  /**
   * Bulk photo upload, step 1: check a batch of filenames before any bytes are
   * sent. Each name must be "<cc>.jpg|jpeg|png"; the student must exist inside
   * `studentScope` (the caller's data scope).
   */
  async previewBulkStudentPhotos(
    filenames: string[],
    studentScope: Record<string, any>,
  ): Promise<BulkPhotoRow[]> {
    const parsed = filenames.map((file) => ({ file, p: parseCcFilename(file) }));
    const ccCounts = new Map<number, number>();
    for (const { p } of parsed) if (p) ccCounts.set(p.cc, (ccCounts.get(p.cc) ?? 0) + 1);

    const ccs = [...ccCounts.keys()];
    const students = ccs.length
      ? await this.prisma.students.findMany({
          where: { ...studentScope, cc: { in: ccs }, deleted_at: null },
          select: {
            cc: true,
            full_name: true,
            gr_number: true,
            photograph_url: true,
            classes: { select: { description: true } },
            sections: { select: { description: true } },
          },
        })
      : [];
    const byCc = new Map(students.map((s) => [s.cc, s]));

    return parsed.map(({ file, p }): BulkPhotoRow => {
      if (!p) {
        return { file, cc: null, status: 'invalid_name', message: 'Name the file by CC only, e.g. 1234.jpg' };
      }
      const s = byCc.get(p.cc);
      const student = s
        ? {
            full_name: s.full_name,
            gr_number: s.gr_number,
            class_name: s.classes?.description ?? null,
            section_name: s.sections?.description ?? null,
            current_photo_url: s.photograph_url,
          }
        : undefined;
      if (!s) return { file, cc: p.cc, status: 'not_found', message: `No student with CC ${p.cc}` };
      if ((ccCounts.get(p.cc) ?? 0) > 1) {
        return { file, cc: p.cc, status: 'duplicate_cc', student, message: 'More than one file for this CC in the batch' };
      }
      return { file, cc: p.cc, status: 'ready', student };
    });
  }

  /**
   * Bulk photo upload, step 2: store each file as a new object, make it the
   * student's current photo and add it to their photo history. Nothing is
   * overwritten or deleted, and an image already in the student's history (same
   * content hash) is skipped, so re-sending a batch is harmless.
   */
  async bulkUploadStudentPhotos(
    files: Express.Multer.File[],
    studentScope: Record<string, any>,
    uploadedBy: string,
  ): Promise<BulkPhotoRow[]> {
    const checked = await this.previewBulkStudentPhotos(
      files.map((f) => f.originalname),
      studentScope,
    );
    const results: BulkPhotoRow[] = [];
    for (let i = 0; i < files.length; i++) {
      const row = checked[i];
      if (row.status !== 'ready') {
        results.push(row);
        continue;
      }
      try {
        results.push(await this.storeBulkPhoto(files[i], row, uploadedBy));
      } catch (err: any) {
        results.push({ ...row, status: 'error', message: err?.message || 'Upload failed' });
      }
    }
    return results;
  }

  private async storeBulkPhoto(
    file: Express.Multer.File,
    row: BulkPhotoRow,
    uploadedBy: string,
  ): Promise<BulkPhotoRow> {
    const cc = row.cc!;
    const { ext } = parseCcFilename(file.originalname)!;
    const hash = photoContentHash(file.buffer);

    const history = await this.prisma.student_photo_history.findMany({
      where: { student_id: cc },
      select: { url: true },
    });
    const existing = history.find((h) => urlHasContentHash(h.url, hash));
    if (existing) {
      return { ...row, status: 'already_uploaded', url: existing.url, message: 'This image is already in the photo history' };
    }

    const url = await this.storage.upload(
      studentPhotoKey(cc, 'standard', ext, hash),
      file.buffer,
      mimeForExtension(ext),
    );

    await this.prisma.$transaction([
      this.prisma.students.update({ where: { cc }, data: { photograph_url: url } }),
      this.prisma.student_photo_history.create({
        data: { student_id: cc, url, photo_type: 'standard', uploaded_by: uploadedBy, uploaded_at: new Date() },
      }),
    ]);

    await this.auditLogs.log({
      entity_type: 'STUDENT',
      entity_id: String(cc),
      action: 'UPDATED',
      field: 'photograph_url',
      changed_by: uploadedBy,
      student_id: cc,
      note: `Bulk photo upload: new standard photo for CC ${cc} (${row.student?.full_name || 'N/A'}). Previous photo kept in history.`,
    });

    return {
      ...row,
      status: 'uploaded',
      url,
      student: row.student ? { ...row.student, current_photo_url: url } : row.student,
    };
  }

  async getStudentPhotoHistory(cc: number) {
    const student = await this.prisma.students.findUnique({
      where: { cc },
      select: { cc: true, photograph_url: true, doa: true, created_at: true },
    });
    if (!student) throw new NotFoundException(`Student with CC ${cc} not found`);

    const rows = await this.prisma.student_photo_history.findMany({
      where: { student_id: cc },
      orderBy: { uploaded_at: 'asc' },
    });

    if (rows.length === 0 && student.photograph_url) {
      return [
        {
          id: 0,
          student_id: cc,
          url: student.photograph_url,
          photo_type: 'standard',
          uploaded_by: 'system_backfill',
          uploaded_at: student.doa || student.created_at || new Date(),
        },
      ];
    }

    return rows;
  }

  async uploadGuardianPhoto(id: number, file: Express.Multer.File, isTemp = false) {
    const guardian = await this.prisma.guardians.findUnique({ where: { id } });
    if (!guardian) throw new NotFoundException(`Guardian with ID ${id} not found`);

    const extension = file.originalname.split('.').pop() || 'jpg';
    const key = `media/guardians/${id}/profile-${Date.now()}.${extension}`;

    const url = await this.storage.upload(key, file.buffer, file.mimetype);

    if (!isTemp) {
      await this.prisma.guardians.update({
        where: { id },
        data: { photo_url: url },
      });

      await this.auditLogs.log({
        entity_type: 'GUARDIAN',
        entity_id: String(id),
        action: 'UPDATED',
        field: 'photo_url',
        changed_by: 'system',
        note: `Uploaded guardian profile photo for #${id} (${guardian.full_name || 'N/A'}).`,
      });
    }

    return { url };
  }

  async uploadGuardianCnic(id: number, file: Express.Multer.File, isTemp = false) {
    const guardian = await this.prisma.guardians.findUnique({ where: { id } });
    if (!guardian) throw new NotFoundException(`Guardian with ID ${id} not found`);

    const extension = file.originalname.split('.').pop() || 'jpg';
    const key = `media/guardians/${id}/cnic-${Date.now()}.${extension}`;

    const url = await this.storage.upload(key, file.buffer, file.mimetype);

    if (!isTemp) {
      await this.prisma.guardians.update({
        where: { id },
        data: { cnic_pic_url: url },
      });

      await this.auditLogs.log({
        entity_type: 'GUARDIAN',
        entity_id: String(id),
        action: 'UPDATED',
        field: 'cnic_pic_url',
        changed_by: 'system',
        note: `Uploaded guardian CNIC image for #${id} (${guardian.full_name || 'N/A'}).`,
      });
    }

    return { url };
  }

  async uploadEmployeePhoto(
    id: number,
    file: Express.Multer.File,
    slot: 'profile' | 'father' | 'mother' | 'spouse' = 'profile',
  ) {
    const employee = await this.prisma.employee_profiles.findUnique({ where: { id } });
    if (!employee) throw new NotFoundException(`Employee with ID ${id} not found`);

    const extension = file.originalname.split('.').pop() || 'jpg';
    const key = `media/employees/${id}/${slot}-${Date.now()}.${extension}`;

    const url = await this.storage.upload(key, file.buffer, file.mimetype);

    const columnMap: Record<string, string> = {
      profile: 'photo_url',
      father: 'father_photo_url',
      mother: 'mother_photo_url',
      spouse: 'spouse_photo_url',
    };

    const targetColumn = columnMap[slot] || 'photo_url';

    await this.prisma.employee_profiles.update({
      where: { id },
      data: { [targetColumn]: url },
    });

    await this.auditLogs.log({
      entity_type: 'EMPLOYEE',
      entity_id: String(id),
      action: 'UPDATED',
      field: targetColumn,
      changed_by: 'system',
      note: `Uploaded employee ${slot} photo for #${id} (${employee.full_name || 'N/A'}).`,
    });

    return { url };
  }

  async deleteStudentPhoto(cc: number, type: 'standard' | 'blue_bg') {
    const student = await this.prisma.students.findUnique({ where: { cc } });
    if (!student) throw new NotFoundException(`Student with CC ${cc} not found`);

    const field = type === 'blue_bg' ? 'photo_blue_bg_url' : 'photograph_url';
    await this.prisma.students.update({
      where: { cc },
      data: { [field]: null },
    });

    await this.auditLogs.log({
      entity_type: 'STUDENT',
      entity_id: String(cc),
      action: 'UPDATED',
      field,
      changed_by: 'system',
      student_id: cc,
      note: `Removed student ${type === 'blue_bg' ? 'blue-background photo' : 'standard photo'} for CC ${cc}.`,
    });

    return { message: 'Photo removed successfully' };
  }

  async deleteGuardianPhoto(id: number) {
    const guardian = await this.prisma.guardians.findUnique({ where: { id } });
    if (!guardian) throw new NotFoundException(`Guardian with ID ${id} not found`);

    await this.prisma.guardians.update({
      where: { id },
      data: { photo_url: null },
    });

    await this.auditLogs.log({
      entity_type: 'GUARDIAN',
      entity_id: String(id),
      action: 'UPDATED',
      field: 'photo_url',
      changed_by: 'system',
      note: `Removed guardian photo for #${id}.`,
    });

    return { message: 'Photo removed successfully' };
  }

  async deleteEmployeePhoto(id: number, slot: 'profile' | 'father' | 'mother' | 'spouse' = 'profile') {
    const employee = await this.prisma.employee_profiles.findUnique({ where: { id } });
    if (!employee) throw new NotFoundException(`Employee with ID ${id} not found`);

    const columnMap: Record<string, string> = {
      profile: 'photo_url',
      father: 'father_photo_url',
      mother: 'mother_photo_url',
      spouse: 'spouse_photo_url',
    };
    const targetColumn = columnMap[slot] || 'photo_url';

    await this.prisma.employee_profiles.update({
      where: { id },
      data: { [targetColumn]: null },
    });

    await this.auditLogs.log({
      entity_type: 'EMPLOYEE',
      entity_id: String(id),
      action: 'UPDATED',
      field: targetColumn,
      changed_by: 'system',
      note: `Removed employee ${slot} photo for #${id}.`,
    });

    return { message: 'Photo removed successfully' };
  }

  async uploadLeaveAttachment(id: number, file: Express.Multer.File) {
    const employee = await this.prisma.employee_profiles.findUnique({ where: { id } });
    if (!employee) throw new NotFoundException(`Employee with ID ${id} not found`);

    const mime = file.mimetype.toLowerCase();
    const isImage = mime.startsWith('image/');
    const isPdf = mime === 'application/pdf';
    if (!isImage && !isPdf) {
      throw new BadRequestException('Only image or PDF attachments are allowed');
    }

    const extension = file.originalname.split('.').pop() || (isPdf ? 'pdf' : 'jpg');
    const key = `media/employees/${id}/leave-${Date.now()}.${extension}`;
    const url = await this.storage.upload(key, file.buffer, file.mimetype);
    const attachmentType = isImage ? 'image' : 'document';

    await this.auditLogs.log({
      entity_type: 'LEAVE_REQUEST',
      entity_id: String(id),
      action: 'UPDATED',
      field: 'attachment',
      changed_by: 'system',
      note: `Uploaded leave ${attachmentType} attachment for employee #${id} (${employee.full_name || 'N/A'}, file: ${file.originalname}).`,
    });

    return {
      url,
      type: attachmentType,
    };
  }

  async getPhotoBuffer(url: string) {
    // Extract the key from the full CDN URL
    const key = this.storage.extractKeyFromUrl(url);
    return this.storage.getFile(key);
  }
}
