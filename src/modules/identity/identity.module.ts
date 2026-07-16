import { Module } from '@nestjs/common';
import { IdentityController } from './identity.controller';
import { IdentityService } from './identity.service';
import { AuthModule } from '../auth/auth.module';
import { CcAllocatorService } from './cc-allocator.service';

import { StudentFlagsModule } from '../student-flags/student-flags.module';

@Module({
  imports: [AuthModule, StudentFlagsModule],
  controllers: [IdentityController],
  providers: [IdentityService, CcAllocatorService],
  exports: [CcAllocatorService],
})
export class IdentityModule {}
