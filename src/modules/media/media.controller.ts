import {
  Controller,
  Post,
  Param,
  UploadedFile,
  UseInterceptors,
  ParseIntPipe,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
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
}
