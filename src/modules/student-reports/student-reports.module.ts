import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { StudentsModule } from '../students/students.module';
import { StudentReportsController } from './student-reports.controller';
import { StudentReportsService } from './student-reports.service';
import { MovementReportService } from './movement-report.service';

// AuthModule provides CaslAbilityFactory for PoliciesGuard (see TAFSD-441's boot crash).
@Module({
  imports: [PrismaModule, AuthModule, StudentsModule],
  controllers: [StudentReportsController],
  providers: [StudentReportsService, MovementReportService],
})
export class StudentReportsModule {}
