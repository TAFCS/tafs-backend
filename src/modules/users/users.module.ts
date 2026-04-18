import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { PermissionsService } from './permissions.service';

@Module({
  providers: [UsersService, PermissionsService],
  exports: [UsersService, PermissionsService],
})
export class UsersModule {}
