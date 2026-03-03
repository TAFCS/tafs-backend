import { Module } from '@nestjs/common';
import { IdentityController } from './identity.controller';
import { IdentityService } from './identity.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [IdentityController],
  providers: [IdentityService],
})
export class IdentityModule {}
