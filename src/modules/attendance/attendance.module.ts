import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ChatModule } from '../chat/chat.module';
import { FcmModule } from '../../common/fcm/fcm.module';
import { RollSessionsController } from './roll-sessions.controller';
import { RollSessionsService } from './roll-sessions.service';
import { RollCallAnnouncementsService } from './roll-call-announcements.service';
import { RollSessionsSchedulerService } from './roll-sessions-scheduler.service';
import { StaffAttendanceController } from './staff-attendance.controller';
import { StaffAttendanceService } from './staff-attendance.service';
import { ZkAttendanceMappingController } from './zk-attendance-mapping.controller';
import { ZkAttendanceMappingService } from './zk-attendance-mapping.service';
import { ZkAttendanceProcessorService } from './zk-attendance-processor.service';
import { ZkDeviceController, ZkLogsController } from './zk-push.controller';
import { ZkPushService } from './zk-push.service';

@Module({
  imports: [AuthModule, ChatModule, FcmModule],
  controllers: [
    RollSessionsController,
    StaffAttendanceController,
    ZkDeviceController,
    ZkLogsController,
    ZkAttendanceMappingController,
  ],
  providers: [
    RollSessionsService,
    RollCallAnnouncementsService,
    RollSessionsSchedulerService,
    StaffAttendanceService,
    ZkPushService,
    ZkAttendanceProcessorService,
    ZkAttendanceMappingService,
  ],
  exports: [RollSessionsService, StaffAttendanceService],
})
export class AttendanceModule {}
