import { Module, forwardRef } from '@nestjs/common';
import { SupportTicketsModule } from '../support-tickets/support-tickets.module';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { PrismaModule } from '../../../prisma/prisma.module';
import { StorageModule } from '../../common/storage/storage.module';
import { ChatGateway } from './chat.gateway';
import { AuthModule } from '../auth/auth.module';
import { FcmModule } from '../../common/fcm/fcm.module';

@Module({
  imports: [
    PrismaModule,
    StorageModule,
    AuthModule,
    FcmModule,
    forwardRef(() => SupportTicketsModule),
  ],
  providers: [ChatService, ChatGateway],
  controllers: [ChatController],
  exports: [ChatService, ChatGateway],
})
export class ChatModule {}
