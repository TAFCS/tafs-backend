import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';

@Injectable()
export class MediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async uploadStudentPhoto(cc: number, file: Express.Multer.File, type: 'standard' | 'blue_bg', isTemp = false) {
    const student = await this.prisma.students.findUnique({ where: { cc } });
    if (!student) throw new NotFoundException(`Student with CC ${cc} not found`);

    const extension = file.originalname.split('.').pop() || 'jpg';
    const key = `media/students/${cc}/${type}-${Date.now()}.${extension}`;
    
    const url = await this.storage.upload(key, file.buffer, file.mimetype);

    if (!isTemp) {
      const field = type === 'blue_bg' ? 'photo_blue_bg_url' : 'photograph_url';
      
      await this.prisma.students.update({
        where: { cc },
        data: { [field]: url },
      });

      const label = type === 'blue_bg' ? 'blue-background photo' : 'standard photo';
      await this.auditLogs.log({
        entity_type: 'STUDENT',
        entity_id: String(cc),
        action: 'UPDATED',
        field,
        changed_by: 'system',
        student_id: cc,
        note: `Uploaded student ${label} for CC ${cc} (${student.full_name || 'N/A'}).`,
      });
    }

    return { url };
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
    const employee = await this.prisma.employees.findUnique({ where: { id } });
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

    await this.prisma.employees.update({
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
    const employee = await this.prisma.employees.findUnique({ where: { id } });
    if (!employee) throw new NotFoundException(`Employee with ID ${id} not found`);

    const columnMap: Record<string, string> = {
      profile: 'photo_url',
      father: 'father_photo_url',
      mother: 'mother_photo_url',
      spouse: 'spouse_photo_url',
    };
    const targetColumn = columnMap[slot] || 'photo_url';

    await this.prisma.employees.update({
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
