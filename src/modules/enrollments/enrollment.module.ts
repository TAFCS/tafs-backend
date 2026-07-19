import { Module } from '@nestjs/common';
import { EnrollmentService } from './enrollment.service';
import { EnrollmentController } from './enrollment.controller';
import { PrismaModule } from '../../../prisma/prisma.module';
import { StudentAllocationModule } from '../student-allocation/student-allocation.module';

@Module({
  imports: [PrismaModule, StudentAllocationModule],
  controllers: [EnrollmentController],
  providers: [EnrollmentService],
})
export class EnrollmentModule {}
