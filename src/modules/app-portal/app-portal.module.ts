import { Module } from '@nestjs/common';
import { AppPortalController } from './app-portal.controller';
import { AppPortalService } from './app-portal.service';
import { PrismaModule } from '../../../prisma/prisma.module';
import { HrModule } from '../hr/hr.module';
import { AttendanceModule } from '../attendance/attendance.module';

@Module({
  imports: [PrismaModule, HrModule, AttendanceModule],
  controllers: [AppPortalController],
  providers: [AppPortalService],
  exports: [AppPortalService],
})
export class AppPortalModule {}
