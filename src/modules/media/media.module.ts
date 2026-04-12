import { Module } from '@nestjs/common';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { StorageModule } from '../../common/storage/storage.module';
import { PrismaModule } from '../../../prisma/prisma.module';

@Module({
  imports: [StorageModule, PrismaModule],
  controllers: [MediaController],
  providers: [MediaService],
  exports: [MediaService],
})
export class MediaModule {}
