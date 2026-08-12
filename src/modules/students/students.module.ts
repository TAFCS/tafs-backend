import { Module } from '@nestjs/common';
import { StudentsController } from './students.controller';
import { StudentsService } from './students.service';
import { AuthModule } from '../auth/auth.module';
import { StudentAllocationModule } from '../student-allocation/student-allocation.module';
import { ProgressionHistoryModule } from './progression-history.module';
import { EnrollmentModule } from '../enrollments/enrollment.module';

@Module({
  imports: [AuthModule, StudentAllocationModule, ProgressionHistoryModule, EnrollmentModule],
  controllers: [StudentsController],
  providers: [StudentsService],
  exports: [StudentsService],
})
export class StudentsModule {}
