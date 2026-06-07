import {
  Controller,
  Get,
  Patch,
  Body,
  Query,
  Param,
  UseGuards,
  HttpStatus,
  ForbiddenException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AppConfigService } from './app-config.service';
import { AppStatusQueryDto, UpdateAppConfigDto } from './dto/app-config.dto';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { StaffRole } from '@prisma/client';
import { createApiResponse } from '../../utils/serializer.util';

@ApiTags('App Config')
@Controller('app-config')
export class AppConfigController {
  constructor(private readonly appConfigService: AppConfigService) {}

  @Get('status')
  async getStatus(@Query() query: AppStatusQueryDto) {
    const data = await this.appConfigService.getAppStatus(query.platform, query.build);
    return createApiResponse(data, HttpStatus.OK, 'App status retrieved successfully');
  }

  @ApiBearerAuth()
  @Get()
  @UseGuards(JwtStaffGuard)
  async getAllConfigs(@CurrentUser() user: IJwtStaffPayload) {
    if (user.role !== StaffRole.SUPER_ADMIN) {
      throw new ForbiddenException('Access denied. Super Admin role required.');
    }
    const data = await this.appConfigService.getAllConfigs();
    return createApiResponse(data, HttpStatus.OK, 'Configurations retrieved successfully');
  }

  @ApiBearerAuth()
  @Patch(':key')
  @UseGuards(JwtStaffGuard)
  async setConfig(
    @Param('key') key: string,
    @Body() dto: UpdateAppConfigDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    if (user.role !== StaffRole.SUPER_ADMIN) {
      throw new ForbiddenException('Access denied. Super Admin role required.');
    }
    const data = await this.appConfigService.setConfig(key, dto.value, user.username);
    return createApiResponse(data, HttpStatus.OK, 'Configuration updated successfully');
  }
}
