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
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';
import { createApiResponse } from '../../utils/serializer.util';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { CreateAccessPackDto, SetUserAccessDto, UpdateAccessPackDto } from './dto/access.dto';

@Controller('access')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class AccessController {
  constructor(private readonly accessService: AccessService) {}

  @Get('tiles')
  async getCatalog() {
    const catalog = await this.accessService.getCatalog();
    return createApiResponse(catalog, HttpStatus.OK, 'Access catalog retrieved successfully');
  }

  @Get('packs')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Permission'))
  async listPacks() {
    const packs = await this.accessService.listPacks();
    return createApiResponse(packs, HttpStatus.OK, 'Access packs retrieved successfully');
  }

  @Post('packs')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Permission'))
  async createPack(@Body() dto: CreateAccessPackDto, @CurrentUser() user: IJwtStaffPayload) {
    const pack = await this.accessService.createPack(dto, user.username || user.sub);
    return createApiResponse(pack, HttpStatus.CREATED, 'Access pack created successfully');
  }

  @Put('packs/:id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Permission'))
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
  async deletePack(@Param('id') id: string, @CurrentUser() user: IJwtStaffPayload) {
    const result = await this.accessService.deletePack(id, user.username || user.sub);
    return createApiResponse(result, HttpStatus.OK, 'Access pack deleted successfully');
  }

  @Get('users/:id/access')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Permission'))
  async getUserAccess(@Param('id') id: string) {
    const access = await this.accessService.getUserAccess(id);
    return createApiResponse(access, HttpStatus.OK, 'User access retrieved successfully');
  }

  @Put('users/:id/access')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Permission'))
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
    );
    return createApiResponse(access, HttpStatus.OK, 'User access updated successfully');
  }
}
