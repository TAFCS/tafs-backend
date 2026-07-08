import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Res,
  UploadedFile,
  UseInterceptors,
  ParseIntPipe,
  BadRequestException,
  UseGuards,
  ForbiddenException,
  HttpStatus,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { UnconfirmedAdmissionsService } from './unconfirmed-admissions.service';
import { CreateUnconfirmedAdmissionDto } from './dto/create-unconfirmed-admission.dto';
import { ApiTags, ApiOperation, ApiConsumes, ApiBody, ApiBearerAuth } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { createApiResponse } from '../../utils/serializer.util';

@ApiTags('unconfirmed-admissions')
@ApiBearerAuth()
@UseGuards(JwtStaffGuard)
@Controller('unconfirmed-admissions')
export class UnconfirmedAdmissionsController {
  constructor(private readonly service: UnconfirmedAdmissionsService) {}

  private assertSuperAdmin(user: IJwtStaffPayload) {
    if (user.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Only super admins can access unconfirmed admissions');
    }
  }

  @Post()
  @ApiOperation({ summary: 'Create a new unconfirmed admission' })
  async create(
    @Body() dto: CreateUnconfirmedAdmissionDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    this.assertSuperAdmin(user);
    const data = await this.service.create(dto, user.username);
    return createApiResponse(data, HttpStatus.CREATED, 'Unconfirmed admission created successfully');
  }

  @Get(':cc')
  @ApiOperation({ summary: 'Get unconfirmed admission details by CC' })
  async getByCC(
    @Param('cc', ParseIntPipe) cc: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    this.assertSuperAdmin(user);
    const data = await this.service.getByCC(cc);
    return createApiResponse(data, HttpStatus.OK, 'Unconfirmed admission retrieved successfully');
  }

  @Post(':cc/photo')
  @ApiOperation({ summary: 'Upload photograph for unconfirmed admission candidate' })
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
  async uploadPhoto(
    @Param('cc', ParseIntPipe) cc: number,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    this.assertSuperAdmin(user);
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    const data = await this.service.uploadPhoto(cc, file);
    return createApiResponse(data, HttpStatus.OK, 'Photograph uploaded successfully');
  }

  @Get(':cc/deposit-slip')
  @ApiOperation({ summary: 'Get deposit slip PDF for unconfirmed admission' })
  async getDepositSlip(
    @Param('cc', ParseIntPipe) cc: number,
    @Res() res: Response,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    this.assertSuperAdmin(user);
    const pdfBuffer = await this.service.generateDepositSlipPdf(cc);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename=deposit-slip-${cc}.pdf`,
      'Content-Length': pdfBuffer.length,
    });
    res.end(pdfBuffer);
  }
}
