import { Module } from '@nestjs/common';
import { StudentAllocationService } from './student-allocation.service';

@Module({
  providers: [StudentAllocationService],
  exports: [StudentAllocationService],
})
export class StudentAllocationModule {}
