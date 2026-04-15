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
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { MediaService } from './media.service';
import { ApiTags, ApiOperation, ApiConsumes, ApiBody } from '@nestjs/swagger';

@ApiTags('media')
@Controller('media')
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

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
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    if (type !== 'standard' && type !== 'blue_bg') {
      throw new BadRequestException('Invalid photo type. Use "standard" or "blue_bg"');
    }
    return this.mediaService.uploadStudentPhoto(cc, file, type as 'standard' | 'blue_bg');
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
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    return this.mediaService.uploadGuardianPhoto(id, file);
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
