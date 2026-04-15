import { Module } from '@nestjs/common';
import { IdentityController } from './identity.controller';
import { IdentityService } from './identity.service';
import { AuthModule } from '../auth/auth.module';

import { StudentFlagsModule } from '../student-flags/student-flags.module';

@Module({
  imports: [AuthModule, StudentFlagsModule],
  controllers: [IdentityController],
  providers: [IdentityService],
})
export class IdentityModule {}
