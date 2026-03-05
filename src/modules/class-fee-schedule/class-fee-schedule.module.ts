import { Module } from '@nestjs/common';
import { ClassFeeScheduleService } from './class-fee-schedule.service';
import { ClassFeeScheduleController } from './class-fee-schedule.controller';

@Module({
  controllers: [ClassFeeScheduleController],
  providers: [ClassFeeScheduleService],
  exports: [ClassFeeScheduleService],
})
export class ClassFeeScheduleModule {}
