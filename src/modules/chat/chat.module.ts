import { Module } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { PrismaModule } from '../../../prisma/prisma.module';
import { StorageModule } from '../../common/storage/storage.module';

@Module({
  imports: [PrismaModule, StorageModule],
  providers: [ChatService],
  controllers: [ChatController],
  exports: [ChatService]
})
export class ChatModule {}
