import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.service';

@Injectable()
export class MediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async uploadStudentPhoto(cc: number, file: Express.Multer.File, type: 'standard' | 'blue_bg') {
    const student = await this.prisma.students.findUnique({ where: { cc } });
    if (!student) throw new NotFoundException(`Student with CC ${cc} not found`);

    const extension = file.originalname.split('.').pop() || 'jpg';
    const key = `media/students/${cc}/${type}-${Date.now()}.${extension}`;
    
    const url = await this.storage.upload(key, file.buffer, file.mimetype);

    const field = type === 'blue_bg' ? 'photo_blue_bg_url' : 'photograph_url';
    
    await this.prisma.students.update({
      where: { cc },
      data: { [field]: url },
    });

    return { url };
  }

  async uploadGuardianPhoto(id: number, file: Express.Multer.File) {
    const guardian = await this.prisma.guardians.findUnique({ where: { id } });
    if (!guardian) throw new NotFoundException(`Guardian with ID ${id} not found`);

    const extension = file.originalname.split('.').pop() || 'jpg';
    const key = `media/guardians/${id}/profile-${Date.now()}.${extension}`;

    const url = await this.storage.upload(key, file.buffer, file.mimetype);

    await this.prisma.guardians.update({
      where: { id },
      data: { photo_url: url },
    });

    return { url };
  }
}
