import { Module } from '@nestjs/common';
import { NoticeBoardService } from './notice-board.service';
import { NoticeBoardController } from './notice-board.controller';
import { PrismaModule } from '../../../prisma/prisma.module';
import { StorageModule } from '../../common/storage/storage.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [PrismaModule, StorageModule, AuthModule],
  providers: [NoticeBoardService],
  controllers: [NoticeBoardController],
})
export class NoticeBoardModule {}
