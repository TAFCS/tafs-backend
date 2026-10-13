import { Module } from '@nestjs/common';
import { VouchersModule } from '../vouchers/vouchers.module';
import { UblController } from './ubl.controller';
import { UblService } from './ubl.service';

@Module({
  imports: [VouchersModule],
  controllers: [UblController],
  providers: [UblService],
  exports: [UblService],
})
export class UblModule {}
