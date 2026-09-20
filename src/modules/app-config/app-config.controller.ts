import {
  Controller,
  Get,
  Patch,
  Body,
  Query,
  Param,
  UseGuards,
  HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AppConfigService } from './app-config.service';
import { AppStatusQueryDto, UpdateAppConfigDto } from './dto/app-config.dto';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { RequireAnyAction } from '../../decorators/require-action.decorator';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
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
  @UseGuards(JwtStaffGuard, TileActionGuard)
  @RequireAnyAction('communication.notification_templates#view', 'system.developer_settings#view')
  async getAllConfigs() {
    const data = await this.appConfigService.getAllConfigs();
    return createApiResponse(data, HttpStatus.OK, 'Configurations retrieved successfully');
  }

  @ApiBearerAuth()
  @Patch(':key')
  @UseGuards(JwtStaffGuard, TileActionGuard)
  @RequireAnyAction('communication.notification_templates#edit', 'system.developer_settings#edit')
  async setConfig(
    @Param('key') key: string,
    @Body() dto: UpdateAppConfigDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.appConfigService.setConfig(key, dto.value, user.username);
    return createApiResponse(data, HttpStatus.OK, 'Configuration updated successfully');
  }
}
