import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { AuthModule } from '../auth/auth.module';
import { PostdatedChequesModule } from '../postdated-cheques/postdated-cheques.module';

@Module({
  imports: [AuthModule, PostdatedChequesModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
