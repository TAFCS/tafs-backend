import { Module } from '@nestjs/common';
import { MailerModule } from '../../common/mailer/mailer.module';
import { DailyDigestService } from './daily-digest.service';
import { DailyDigestSchedulerService } from './daily-digest-scheduler.service';

@Module({
  imports: [MailerModule],
  providers: [DailyDigestService, DailyDigestSchedulerService],
  exports: [DailyDigestService],
})
export class DailyDigestModule {}
