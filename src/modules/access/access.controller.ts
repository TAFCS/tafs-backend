import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { AccessService } from './access.service';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { RequireAction } from '../../decorators/require-action.decorator';
import { Action } from '../auth/casl/actions';
import { createApiResponse } from '../../utils/serializer.util';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { CreateAccessPackDto, SetUserAccessDto, UpdateAccessPackDto } from './dto/access.dto';

@Controller('access')
@UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
export class AccessController {
  constructor(private readonly accessService: AccessService) {}

  // Used by every logged-in staff session to render its own nav (see
  // useAccessCatalog on the webapp) -- not specific to any one tile, and
  // deliberately ungated beyond authentication.
  @Get('tiles')
  async getCatalog() {
    const catalog = await this.accessService.getCatalog();
    return createApiResponse(catalog, HttpStatus.OK, 'Access catalog retrieved successfully');
  }

  @Get('scope-options')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Permission'))
  @RequireAction('system.people_access#view')
  async getScopeOptions() {
    const options = await this.accessService.getScopeOptions();
    return createApiResponse(options, HttpStatus.OK, 'Scope options retrieved successfully');
  }

  // Shared with the separate Access Packs tile (system.access_packs, the
  // /system/permissions page) -- read-only here, so left undecorated rather
  // than requiring a system.people_access action for a page that isn't this
  // one. The packs CRUD routes below belong to that tile entirely and carry its
  // `manage` action.
  @Get('packs')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Permission'))
  async listPacks() {
    const packs = await this.accessService.listPacks();
    return createApiResponse(packs, HttpStatus.OK, 'Access packs retrieved successfully');
  }

  @Post('packs')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Permission'))
  @RequireAction('system.access_packs#manage')
  async createPack(@Body() dto: CreateAccessPackDto, @CurrentUser() user: IJwtStaffPayload) {
    const pack = await this.accessService.createPack(dto, user.username || user.sub);
    return createApiResponse(pack, HttpStatus.CREATED, 'Access pack created successfully');
  }

  @Put('packs/:id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Permission'))
  @RequireAction('system.access_packs#manage')
  async updatePack(
    @Param('id') id: string,
    @Body() dto: UpdateAccessPackDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const pack = await this.accessService.updatePack(id, dto, user.username || user.sub);
    return createApiResponse(pack, HttpStatus.OK, 'Access pack updated successfully');
  }

  @Delete('packs/:id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Permission'))
  @RequireAction('system.access_packs#manage')
  async deletePack(@Param('id') id: string, @CurrentUser() user: IJwtStaffPayload) {
    const result = await this.accessService.deletePack(id, user.username || user.sub);
    return createApiResponse(result, HttpStatus.OK, 'Access pack deleted successfully');
  }

  @Get('users/:id/access')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Permission'))
  @RequireAction('system.people_access#view')
  async getUserAccess(@Param('id') id: string, @CurrentUser() user: IJwtStaffPayload) {
    const access = await this.accessService.getUserAccess(id, user);
    return createApiResponse(access, HttpStatus.OK, 'User access retrieved successfully');
  }

  // Only `view` is required at the route: this PUT writes fields belonging to
  // both the Access and Scope tabs, so authorisation happens per field in
  // AccessService.assertUserAccessFieldsEditable.
  @Put('users/:id/access')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Permission'))
  @RequireAction('system.people_access#view')
  async setUserAccess(
    @Param('id') id: string,
    @Body() dto: SetUserAccessDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const access = await this.accessService.setUserAccess(
      id,
      dto,
      user.sub,
      user.username || user.sub,
      user,
    );
    return createApiResponse(access, HttpStatus.OK, 'User access updated successfully');
  }
}
