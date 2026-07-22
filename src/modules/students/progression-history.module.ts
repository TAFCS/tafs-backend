import { Module } from '@nestjs/common';
import { ProgressionHistoryService } from './progression-history.service';

@Module({
  providers: [ProgressionHistoryService],
  exports: [ProgressionHistoryService],
})
export class ProgressionHistoryModule {}
