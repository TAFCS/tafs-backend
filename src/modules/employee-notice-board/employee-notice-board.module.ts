import { Module } from '@nestjs/common';
import { EmployeeNoticeBoardService } from './employee-notice-board.service';
import { EmployeeNoticeBoardController } from './employee-notice-board.controller';
import { PrismaModule } from '../../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { FcmModule } from '../../common/fcm/fcm.module';

@Module({
  imports: [PrismaModule, AuthModule, FcmModule],
  providers: [EmployeeNoticeBoardService],
  controllers: [EmployeeNoticeBoardController],
  exports: [EmployeeNoticeBoardService],
})
export class EmployeeNoticeBoardModule {}
