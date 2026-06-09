import { Module } from '@nestjs/common';
import { StaffEditingController } from './staff-editing.controller';
import { StaffEditingService } from './staff-editing.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [StaffEditingController],
  providers: [StaffEditingService],
})
export class StaffEditingModule {}
