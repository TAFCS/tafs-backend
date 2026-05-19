import { Module } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { PrismaModule } from '../../../prisma/prisma.module';
import { StorageModule } from '../../common/storage/storage.module';
import { ChatGateway } from './chat.gateway';
import { AuthModule } from '../auth/auth.module';
import { FcmService } from './fcm.service';

@Module({
  imports: [PrismaModule, StorageModule, AuthModule],
  providers: [ChatService, ChatGateway, FcmService],
  controllers: [ChatController],
  exports: [ChatService, ChatGateway],
})
export class ChatModule {}
