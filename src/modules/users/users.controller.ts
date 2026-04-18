import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { SetPermissionDto } from './dto/set-permission.dto';
import { UpdateRolePermissionDto } from './dto/update-role-permission.dto';
import { createApiResponse } from '../../utils/serializer.util';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { StaffRole } from '@prisma/client';

@Controller('users')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'User'))
  async listUsers() {
    const users = await this.usersService.listUsers();
    return createApiResponse(users, HttpStatus.OK, 'Users retrieved successfully');
  }

  @Get(':id')
  @CheckPolicies((ability) => ability.can(Action.Read, 'User'))
  async findUser(@Param('id') id: string) {
    const user = await this.usersService.findUserById(id);
    return createApiResponse(user, HttpStatus.OK, 'User details retrieved successfully');
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @CheckPolicies((ability) => ability.can(Action.Create, 'User'))
  async createUser(@Body() dto: CreateUserDto, @CurrentUser() creator: IJwtStaffPayload) {
    const user = await this.usersService.createUser(dto, creator.sub);
    return createApiResponse(user, HttpStatus.CREATED, 'User created successfully');
  }

  @Put(':id')
  @CheckPolicies((ability) => ability.can(Action.Update, 'User'))
  async updateUser(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    const user = await this.usersService.updateUser(id, dto);
    return createApiResponse(user, HttpStatus.OK, 'User updated successfully');
  }

  @Get(':id/permissions')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Permission'))
  async getUserPermissions(@Param('id') id: string) {
    const user = await this.usersService.findUserById(id);
    const permissions = await this.usersService.getUserPermissionState(id, user.role);
    return createApiResponse(permissions, HttpStatus.OK, 'User permissions retrieved successfully');
  }

  @Post(':id/permissions')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Permission'))
  async setPermission(
    @Param('id') id: string,
    @Body() dto: SetPermissionDto,
    @CurrentUser() grantor: IJwtStaffPayload,
  ) {
    const result = await this.usersService.setPermission(id, dto, grantor.sub);
    return createApiResponse(result, HttpStatus.OK, 'Permission override set successfully');
  }

  @Delete(':id/permissions/:key')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Permission'))
  async removePermissionOverride(@Param('id') id: string, @Param('key') key: string) {
    const result = await this.usersService.removePermissionOverride(id, key);
    return createApiResponse(result, HttpStatus.OK, 'Permission override removed successfully');
  }

  @Get('permissions/all')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Permission'))
  async listAllPermissions() {
    const permissions = await this.usersService.listAllPermissions();
    return createApiResponse(permissions, HttpStatus.OK, 'Permissions list retrieved successfully');
  }

  @Get('roles/:role/permissions')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Permission'))
  async getRolePermissions(@Param('role') role: StaffRole) {
    const permissions = await this.usersService.listRolePermissions(role);
    return createApiResponse(permissions, HttpStatus.OK, `Permissions for ${role} retrieved successfully`);
  }

  @Post('roles/permissions')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Permission'))
  async updateRolePermission(@Body() dto: UpdateRolePermissionDto) {
    const result = await this.usersService.updateRolePermission(dto);
    return createApiResponse(result, HttpStatus.OK, 'Role permission updated successfully');
  }
}
