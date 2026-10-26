import { Module, forwardRef } from '@nestjs/common';
import { NoticeBoardService } from './notice-board.service';
import { NoticeBoardController } from './notice-board.controller';
import { PrismaModule } from '../../../prisma/prisma.module';
import { StorageModule } from '../../common/storage/storage.module';
import { AuthModule } from '../auth/auth.module';
import { FcmModule } from '../../common/fcm/fcm.module';
import { ChatModule } from '../chat/chat.module';
import { StaffNotificationsModule } from '../staff-notifications/staff-notifications.module';

@Module({
  imports: [
    PrismaModule,
    StorageModule,
    forwardRef(() => AuthModule),
    FcmModule,
    forwardRef(() => ChatModule),
    StaffNotificationsModule,
  ],
  providers: [NoticeBoardService],
  controllers: [NoticeBoardController],
  exports: [NoticeBoardService],
})
export class NoticeBoardModule {}
