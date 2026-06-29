import { Module } from '@nestjs/common';
import { FcmModule } from '../../../common/fcm/fcm.module';
import { AuthModule } from '../../auth/auth.module';
import { EmployeeNoticeBoardModule } from '../../employee-notice-board/employee-notice-board.module';
import { SaturdaySchedulesController } from './saturday-schedules.controller';
import { SaturdaySchedulesService } from './saturday-schedules.service';

@Module({
  imports: [AuthModule, FcmModule, EmployeeNoticeBoardModule],
  controllers: [SaturdaySchedulesController],
  providers: [SaturdaySchedulesService],
})
export class SaturdaySchedulesModule {}
