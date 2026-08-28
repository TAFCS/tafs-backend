import { Module } from '@nestjs/common';
import { VouchersModule } from '../vouchers/vouchers.module';
import { MeezanController } from './meezan.controller';
import { MeezanService } from './meezan.service';

@Module({
  imports: [VouchersModule],
  controllers: [MeezanController],
  providers: [MeezanService],
  exports: [MeezanService],
})
export class MeezanModule {}
