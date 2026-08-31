import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { HrModule } from '../hr/hr.module';
import { ChatModule } from '../chat/chat.module';
import { FcmModule } from '../../common/fcm/fcm.module';
import { TimetablesModule } from '../timetables/timetables.module';
import { EmployeeNoticeBoardModule } from '../employee-notice-board/employee-notice-board.module';
import { AttendanceNotificationsController } from './attendance-notifications.controller';
import { AttendanceNotificationsService } from './attendance-notifications.service';
import { RollSessionsController } from './roll-sessions.controller';
import { RollSessionsService } from './roll-sessions.service';
import { RollCallAnnouncementsService } from './roll-call-announcements.service';
import { RollSessionsSchedulerService } from './roll-sessions-scheduler.service';
import { StaffAttendanceController } from './staff-attendance.controller';
import { StaffAttendanceService } from './staff-attendance.service';
import { AttendanceObjectionsController } from './attendance-objections.controller';
import { AttendanceObjectionsService } from './attendance-objections.service';
import { StudentAttendanceController } from './student-attendance.controller';
import { StudentAttendanceService } from './student-attendance.service';
import { ZkAttendanceMappingController } from './zk-attendance-mapping.controller';
import { ZkAttendanceMappingService } from './zk-attendance-mapping.service';
import { ZkAttendanceProcessorService } from './zk-attendance-processor.service';
import { ZkScanResolutionService } from './zk-scan-resolution.service';
import { ZkScanResolutionController } from './zk-scan-resolution.controller';
import { ZkDeviceController, ZkLogsController } from './zk-push.controller';
import { ZkPushService } from './zk-push.service';
import { AttendancePolicyResolverService } from './attendance-policy-resolver.service';
import { ClassCheckInScheduleService } from './class-check-in-schedule.service';
import { ClassCheckInScheduleController } from './class-check-in-schedule.controller';
import { RecomputeLateController } from './recompute-late.controller';
import { Coral9AttendanceWriterService } from './coral9-attendance-writer.service';
import { Coral9SchedulerService } from './coral9-scheduler.service';

@Module({
  imports: [
    AuthModule,
    HrModule,
    forwardRef(() => ChatModule),
    FcmModule,
    TimetablesModule,
    EmployeeNoticeBoardModule,
  ],
  controllers: [
    RollSessionsController,
    StaffAttendanceController,
    AttendanceObjectionsController,
    StudentAttendanceController,
    ZkDeviceController,
    ZkLogsController,
    ZkAttendanceMappingController,
    ZkScanResolutionController,
    AttendanceNotificationsController,
    ClassCheckInScheduleController,
    RecomputeLateController,
  ],
  providers: [
    RollSessionsService,
    RollCallAnnouncementsService,
    RollSessionsSchedulerService,
    StaffAttendanceService,
    AttendanceObjectionsService,
    StudentAttendanceService,
    ZkPushService,
    ZkAttendanceProcessorService,
    ZkScanResolutionService,
    ZkAttendanceMappingService,
    AttendanceNotificationsService,
    AttendancePolicyResolverService,
    ClassCheckInScheduleService,
    Coral9AttendanceWriterService,
    Coral9SchedulerService,
  ],
  exports: [
    RollSessionsService,
    StaffAttendanceService,
    StudentAttendanceService,
    AttendancePolicyResolverService,
    ZkAttendanceProcessorService,
  ],
})
export class AttendanceModule {}
