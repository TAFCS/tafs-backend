import { Module } from '@nestjs/common';
import { StaffEditingController } from './staff-editing.controller';
import { StaffEditingService } from './staff-editing.service';
import { AuthModule } from '../auth/auth.module';
import { StudentAllocationModule } from '../student-allocation/student-allocation.module';

@Module({
  imports: [AuthModule, StudentAllocationModule],
  controllers: [StaffEditingController],
  providers: [StaffEditingService],
})
export class StaffEditingModule {}
