import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { EmployeeNoticeBoardModule } from '../../employee-notice-board/employee-notice-board.module';
import { ShiftOverridesController } from './shift-overrides.controller';
import { ShiftOverridesService } from './shift-overrides.service';

@Module({
  imports: [AuthModule, EmployeeNoticeBoardModule],
  controllers: [ShiftOverridesController],
  providers: [ShiftOverridesService],
})
export class ShiftOverridesModule {}
