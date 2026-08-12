import { Module } from '@nestjs/common';
import { EnrollmentService } from './enrollment.service';
import { EnrollmentController } from './enrollment.controller';
import { PrismaModule } from '../../../prisma/prisma.module';
import { StudentAllocationModule } from '../student-allocation/student-allocation.module';
import { ProgressionHistoryModule } from '../students/progression-history.module';

@Module({
  imports: [PrismaModule, StudentAllocationModule, ProgressionHistoryModule],
  controllers: [EnrollmentController],
  providers: [EnrollmentService],
  exports: [EnrollmentService],
})
export class EnrollmentModule {}
