import { Module } from '@nestjs/common';
import { StaffEditingController } from './staff-editing.controller';
import { StaffEditingService } from './staff-editing.service';
import { AuthModule } from '../auth/auth.module';
import { StudentAllocationModule } from '../student-allocation/student-allocation.module';
import { ProgressionHistoryModule } from '../students/progression-history.module';
import { StorageModule } from '../../common/storage/storage.module';

@Module({
  imports: [AuthModule, StudentAllocationModule, ProgressionHistoryModule, StorageModule],
  controllers: [StaffEditingController],
  providers: [StaffEditingService],
})
export class StaffEditingModule {}
