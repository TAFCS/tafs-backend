import { Module } from '@nestjs/common';
import { FcmModule } from '../../../common/fcm/fcm.module';
import { AuthModule } from '../../auth/auth.module';
import { CalendarDayResolverService } from '../calendar/calendar-day-resolver.service';
import { EmployeeProfileResolverService } from '../employee-profile-resolver.service';
import { LeaveAttendanceSyncService } from './leave-attendance-sync.service';
import { LeaveRequestsController } from './leave-requests.controller';
import { LeaveRequestsSelfController } from './leave-requests-self.controller';
import { LeaveRequestsService } from './leave-requests.service';
import { PermanentEmployeeScheduler } from './permanent-employee.scheduler';

@Module({
  imports: [AuthModule, FcmModule],
  controllers: [LeaveRequestsSelfController, LeaveRequestsController],
  providers: [
    LeaveRequestsService,
    LeaveAttendanceSyncService,
    PermanentEmployeeScheduler,
    CalendarDayResolverService,
    EmployeeProfileResolverService,
  ],
  exports: [LeaveRequestsService, LeaveAttendanceSyncService],
})
export class LeavesModule {}
