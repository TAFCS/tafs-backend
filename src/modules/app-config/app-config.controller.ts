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
import { AppStatusQueryDto, BatchUpdateAppConfigDto, UpdateAppConfigDto } from './dto/app-config.dto';
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
    const data = await this.appConfigService.getAppStatus(query.platform, query.build, query.app);
    return createApiResponse(data, HttpStatus.OK, 'App status retrieved successfully');
  }

  // Any signed-in staff member may read this one value: the payroll and
  // attendance screens that gate same-day overrides need it, and their users
  // don't hold developer-settings access.
  @ApiBearerAuth()
  @Get('attendance-override-cutoff')
  @UseGuards(JwtStaffGuard)
  async getAttendanceOverrideCutoff() {
    const cutoff = await this.appConfigService.getAttendanceOverrideCutoff();
    return createApiResponse({ cutoff }, HttpStatus.OK, 'Attendance override cut-off retrieved successfully');
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
  @Patch()
  @UseGuards(JwtStaffGuard, TileActionGuard)
  @RequireAnyAction('communication.notification_templates#edit', 'system.developer_settings#edit')
  async batchSetConfigs(
    @Body() dto: BatchUpdateAppConfigDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.appConfigService.batchSetConfigs(dto.updates, user);
    return createApiResponse(data, HttpStatus.OK, 'Configurations updated successfully');
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
    const data = await this.appConfigService.batchSetConfigs([{ key, value: dto.value }], user);
    return createApiResponse(data[0], HttpStatus.OK, 'Configuration updated successfully');
  }
}
