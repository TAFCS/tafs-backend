import { Module, forwardRef } from '@nestjs/common';
import { NoticeBoardService } from './notice-board.service';
import { NoticeBoardController } from './notice-board.controller';
import { PrismaModule } from '../../../prisma/prisma.module';
import { StorageModule } from '../../common/storage/storage.module';
import { AuthModule } from '../auth/auth.module';
import { FcmModule } from '../../common/fcm/fcm.module';
import { ChatModule } from '../chat/chat.module';

@Module({
  imports: [
    PrismaModule,
    StorageModule,
    AuthModule,
    FcmModule,
    forwardRef(() => ChatModule),
  ],
  providers: [NoticeBoardService],
  controllers: [NoticeBoardController],
})
export class NoticeBoardModule {}
