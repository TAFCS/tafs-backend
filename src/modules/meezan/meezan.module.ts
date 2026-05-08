import { Module } from '@nestjs/common';
import { MeezanController } from './meezan.controller';
import { MeezanService } from './meezan.service';

@Module({
  controllers: [MeezanController],
  providers: [MeezanService],
  exports: [MeezanService],
})
export class MeezanModule {}
