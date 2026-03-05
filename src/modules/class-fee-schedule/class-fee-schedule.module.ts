import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ClassFeeScheduleService } from './class-fee-schedule.service';
import { ClassFeeScheduleController } from './class-fee-schedule.controller';

@Module({
  imports: [AuthModule],
  controllers: [ClassFeeScheduleController],
  providers: [ClassFeeScheduleService],
  exports: [ClassFeeScheduleService],
})
export class ClassFeeScheduleModule {}
