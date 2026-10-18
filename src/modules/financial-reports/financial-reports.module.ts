import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FinancialReportsController } from './financial-reports.controller';
import { FinancialReportsService } from './financial-reports.service';
import { DefaulterNotifyService } from './defaulter-notify.service';
import { NoticeBoardModule } from '../notice-board/notice-board.module';

@Module({
  imports: [AuthModule, NoticeBoardModule],
  controllers: [FinancialReportsController],
  providers: [FinancialReportsService, DefaulterNotifyService],
})
export class FinancialReportsModule {}
