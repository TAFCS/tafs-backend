import { Module } from '@nestjs/common';
import { FcmService } from './fcm.service';
import { PrismaModule } from '../../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [FcmService],
  exports: [FcmService],
})
export class FcmModule { }
