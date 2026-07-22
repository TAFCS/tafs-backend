import { Module } from '@nestjs/common';
import { StaffEditingController } from './staff-editing.controller';
import { StaffEditingService } from './staff-editing.service';
import { AuthModule } from '../auth/auth.module';
import { StudentAllocationModule } from '../student-allocation/student-allocation.module';
import { ProgressionHistoryModule } from '../students/progression-history.module';

@Module({
  imports: [AuthModule, StudentAllocationModule, ProgressionHistoryModule],
  controllers: [StaffEditingController],
  providers: [StaffEditingService],
})
export class StaffEditingModule {}
