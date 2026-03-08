import { Module } from '@nestjs/common';
import { StaffEditingController } from './staff-editing.controller';
import { StaffEditingService } from './staff-editing.service';

@Module({
  controllers: [StaffEditingController],
  providers: [StaffEditingService],
})
export class StaffEditingModule {}
