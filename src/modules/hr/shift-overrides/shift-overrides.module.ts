import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { ShiftOverridesController } from './shift-overrides.controller';
import { ShiftOverridesService } from './shift-overrides.service';

@Module({
  imports: [AuthModule],
  controllers: [ShiftOverridesController],
  providers: [ShiftOverridesService],
})
export class ShiftOverridesModule {}
