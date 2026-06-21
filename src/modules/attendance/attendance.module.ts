import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { HrModule } from '../hr/hr.module';
import { ChatModule } from '../chat/chat.module';
import { FcmModule } from '../../common/fcm/fcm.module';
import { AttendanceNotificationsController } from './attendance-notifications.controller';
import { AttendanceNotificationsService } from './attendance-notifications.service';
import { RollSessionsController } from './roll-sessions.controller';
import { RollSessionsService } from './roll-sessions.service';
import { RollCallAnnouncementsService } from './roll-call-announcements.service';
import { RollSessionsSchedulerService } from './roll-sessions-scheduler.service';
import { StaffAttendanceController } from './staff-attendance.controller';
import { StaffAttendanceService } from './staff-attendance.service';
import { StudentAttendanceController } from './student-attendance.controller';
import { StudentAttendanceService } from './student-attendance.service';
import { ZkAttendanceMappingController } from './zk-attendance-mapping.controller';
import { ZkAttendanceMappingService } from './zk-attendance-mapping.service';
import { ZkAttendanceProcessorService } from './zk-attendance-processor.service';
import { ZkDeviceController, ZkLogsController } from './zk-push.controller';
import { ZkPushService } from './zk-push.service';

@Module({
  imports: [AuthModule, HrModule, ChatModule, FcmModule],
  controllers: [
    RollSessionsController,
    StaffAttendanceController,
    StudentAttendanceController,
    ZkDeviceController,
    ZkLogsController,
    ZkAttendanceMappingController,
    AttendanceNotificationsController,
  ],
  providers: [
    RollSessionsService,
    RollCallAnnouncementsService,
    RollSessionsSchedulerService,
    StaffAttendanceService,
    StudentAttendanceService,
    ZkPushService,
    ZkAttendanceProcessorService,
    ZkAttendanceMappingService,
    AttendanceNotificationsService,
  ],
  exports: [RollSessionsService, StaffAttendanceService, StudentAttendanceService],
})
export class AttendanceModule {}
