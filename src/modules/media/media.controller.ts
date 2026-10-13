import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
  ParseIntPipe,
  BadRequestException,
  NotFoundException,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { MediaService } from './media.service';
import { ApiTags, ApiOperation, ApiConsumes, ApiBody, ApiBearerAuth } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { JwtStaffOrParentGuard } from '../../common/guards/jwt-staff-or-parent.guard';
import { ScopeService } from '../../common/scope/scope.service';
import { CurrentUser } from '../../decorators/current-user.decorator';
import { hasStaffSelfPermission, LEAVE_APPLY } from '../../common/staff-self-service.util';
import type { IJwtParentPayload, IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';

type Caller = IJwtStaffPayload | IJwtParentPayload;
import { PrismaService } from '../../../prisma/prisma.service';

@ApiTags('media')
@Controller('media')
export class MediaController {
  constructor(
    private readonly mediaService: MediaService,
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
  ) {}

  // ─── Access ─────────────────────────────────────────────────────────────
  // These routes had no guard at all: anyone could overwrite or delete any
  // student, guardian or employee photo, or upload a guardian CNIC. A parent
  // may only stage (temp) uploads for their own family's students and
  // guardians, for a change request; staff are held to their data scope.
  // Missing and out-of-reach both 404, so an id's existence is not confirmed.

  private async assertStudentAccess(user: Caller, cc: number, temp: boolean) {
    const where = user.userType === 'PARENT'
      ? (temp ? { cc, family_id: user.familyId } : null)
      : { cc, ...this.scope.whereForStudents(user) };
    if (!where || (await this.prisma.students.count({ where })) === 0) {
      throw new NotFoundException(`Student #${cc} not found`);
    }
  }

  private async assertGuardianAccess(user: Caller, guardianId: number, temp: boolean) {
    if (user.userType !== 'PARENT' && this.scope.isUnrestricted(user)) return;
    const students = user.userType === 'PARENT'
      ? (temp ? { family_id: user.familyId } : null)
      : this.scope.whereForStudents(user);
    const linked = students
      ? await this.prisma.student_guardians.count({ where: { guardian_id: guardianId, students } })
      : 0;
    if (!linked) throw new NotFoundException(`Guardian #${guardianId} not found`);
  }

  private async assertEmployeeAccess(user: Caller, employeeId: number) {
    if (user.userType === 'PARENT') throw new NotFoundException(`Employee #${employeeId} not found`);
    const visible = await this.prisma.employee_profiles.count({
      where: { id: employeeId, ...this.scope.whereForEmployees(user) },
    });
    if (!visible) throw new NotFoundException(`Employee #${employeeId} not found`);
  }

  @Post('student/:cc/photo/:type')
  @UseGuards(JwtStaffOrParentGuard)
  @ApiOperation({ summary: 'Upload student photo (standard or blue_bg)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @UseInterceptors(FileInterceptor('file'))
  async uploadStudentPhoto(
    @Param('cc', ParseIntPipe) cc: number,
    @Param('type') type: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: Caller,
    @Query('temp') temp?: string,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    await this.assertStudentAccess(user, cc, temp === 'true');
    if (type !== 'standard' && type !== 'blue_bg') {
      throw new BadRequestException('Invalid photo type. Use "standard" or "blue_bg"');
    }
    const isTemp = temp === 'true';
    return this.mediaService.uploadStudentPhoto(cc, file, type as 'standard' | 'blue_bg', isTemp);
  }

  @Post('guardian/:id/photo')
  @UseGuards(JwtStaffOrParentGuard)
  @ApiOperation({ summary: 'Upload guardian photo' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @UseInterceptors(FileInterceptor('file'))
  async uploadGuardianPhoto(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: Caller,
    @Query('temp') temp?: string,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    const isTemp = temp === 'true';
    await this.assertGuardianAccess(user, id, isTemp);
    return this.mediaService.uploadGuardianPhoto(id, file, isTemp);
  }

  @Post('guardian/:id/cnic')
  @UseGuards(JwtStaffOrParentGuard)
  @ApiOperation({ summary: 'Upload guardian CNIC card image' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @UseInterceptors(FileInterceptor('file'))
  async uploadGuardianCnic(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: Caller,
    @Query('temp') temp?: string,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    const isTemp = temp === 'true';
    await this.assertGuardianAccess(user, id, isTemp);
    return this.mediaService.uploadGuardianCnic(id, file, isTemp);
  }

  @Post('employee/:id/photo')
  @UseGuards(JwtStaffOrParentGuard)
  @ApiOperation({ summary: 'Upload employee photo for slot (profile, father, mother, spouse)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @UseInterceptors(FileInterceptor('file'))
  async uploadEmployeePhoto(
    @Param('id', ParseIntPipe) id: number,
    @Query('slot') slot: 'profile' | 'father' | 'mother' | 'spouse' = 'profile',
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: Caller,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    await this.assertEmployeeAccess(user, id);
    return this.mediaService.uploadEmployeePhoto(id, file, slot);
  }

  @Delete('student/:cc/photo/:type')
  @UseGuards(JwtStaffOrParentGuard)
  @ApiOperation({ summary: 'Delete student photo (standard or blue_bg)' })
  async deleteStudentPhoto(
    @Param('cc', ParseIntPipe) cc: number,
    @Param('type') type: string,
    @CurrentUser() user: Caller,
  ) {
    await this.assertStudentAccess(user, cc, false);
    if (type !== 'standard' && type !== 'blue_bg') {
      throw new BadRequestException('Invalid photo type. Use "standard" or "blue_bg"');
    }
    return this.mediaService.deleteStudentPhoto(cc, type as 'standard' | 'blue_bg');
  }

  @Delete('guardian/:id/photo')
  @UseGuards(JwtStaffOrParentGuard)
  @ApiOperation({ summary: 'Delete guardian photo' })
  async deleteGuardianPhoto(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: Caller,
  ) {
    await this.assertGuardianAccess(user, id, false);
    return this.mediaService.deleteGuardianPhoto(id);
  }

  @Delete('employee/:id/photo')
  @UseGuards(JwtStaffOrParentGuard)
  @ApiOperation({ summary: 'Delete employee photo' })
  async deleteEmployeePhoto(
    @Param('id', ParseIntPipe) id: number,
    @Query('slot') slot: 'profile' | 'father' | 'mother' | 'spouse' = 'profile',
    @CurrentUser() user: Caller,
  ) {
    await this.assertEmployeeAccess(user, id);
    return this.mediaService.deleteEmployeePhoto(id, slot);
  }

  @Post('employee/:id/leave-attachment')
  @ApiBearerAuth()
  @UseGuards(JwtStaffGuard)
  @ApiOperation({ summary: 'Upload sick leave attachment (image or PDF)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }),
  )
  async uploadLeaveAttachment(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    await this.assertLeaveAttachmentAccess(user, id);
    return this.mediaService.uploadLeaveAttachment(id, file);
  }

  private async assertLeaveAttachmentAccess(user: IJwtStaffPayload, employeeId: number) {
    if (hasStaffSelfPermission(user, LEAVE_APPLY)) {
      const profile = await this.prisma.employee_profiles.findUnique({
        where: { user_id: user.sub },
        select: { id: true },
      });
      if (profile?.id === employeeId) return;
    }
    throw new ForbiddenException('You can only upload leave attachments for your own profile');
  }

  @Get('proxy')
  @ApiOperation({ summary: 'Proxy an image from the CDN to bypass CORS' })
  async getProxy(
    @Query('url') url: string,
    @Res() res: any,
  ) {
    if (!url) throw new BadRequestException('URL query parameter is required');
    
    // Security check: only allow TAFS CDN URLs
    const cdnBase = process.env.DO_SPACES_CDN_ENDPOINT?.replace(/\/+$/, '');
    if (cdnBase && !url.startsWith(cdnBase)) {
      throw new BadRequestException('Only internal CDN URLs can be proxied');
    }

    try {
      const { buffer, mime } = await this.mediaService.getPhotoBuffer(url);
      res.set('Content-Type', mime);
      res.set('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
      res.send(buffer);
    } catch (err) {
      throw new NotFoundException('Could not proxy image');
    }
  }
}
