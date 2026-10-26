import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { FcmModule } from '../../common/fcm/fcm.module';
import { EmployeeNoticeBoardModule } from '../employee-notice-board/employee-notice-board.module';
import { StaffNotificationsService } from './staff-notifications.service';
import { StaffNotificationsController } from './staff-notifications.controller';

@Module({
  imports: [PrismaModule, forwardRef(() => AuthModule), FcmModule, forwardRef(() => EmployeeNoticeBoardModule)],
  providers: [StaffNotificationsService],
  controllers: [StaffNotificationsController],
  exports: [StaffNotificationsService],
})
export class StaffNotificationsModule {}
