import {
  Controller,
  Post,
  Get,
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
import { CurrentUser } from '../../decorators/current-user.decorator';
import { hasStaffSelfPermission, LEAVE_APPLY } from '../../common/staff-self-service.util';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { PrismaService } from '../../../prisma/prisma.service';

@ApiTags('media')
@Controller('media')
export class MediaController {
  constructor(
    private readonly mediaService: MediaService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('student/:cc/photo/:type')
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
    @Query('temp') temp?: string,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    if (type !== 'standard' && type !== 'blue_bg') {
      throw new BadRequestException('Invalid photo type. Use "standard" or "blue_bg"');
    }
    const isTemp = temp === 'true';
    return this.mediaService.uploadStudentPhoto(cc, file, type as 'standard' | 'blue_bg', isTemp);
  }

  @Post('guardian/:id/photo')
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
    @Query('temp') temp?: string,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    const isTemp = temp === 'true';
    return this.mediaService.uploadGuardianPhoto(id, file, isTemp);
  }

  @Post('guardian/:id/cnic')
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
    @Query('temp') temp?: string,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    const isTemp = temp === 'true';
    return this.mediaService.uploadGuardianCnic(id, file, isTemp);
  }

  @Post('employee/:id/photo')
  @ApiOperation({ summary: 'Upload employee profile photo' })
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
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    return this.mediaService.uploadEmployeePhoto(id, file);
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
