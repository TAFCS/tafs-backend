import { Module } from '@nestjs/common';
import { FeesController } from './fees.controller';
import { FeesService } from './fees.service';
import { AuthModule } from '../auth/auth.module';
import { VouchersModule } from '../vouchers/vouchers.module';

@Module({
  imports: [AuthModule, VouchersModule],
  controllers: [FeesController],
  providers: [FeesService],
})
export class FeesModule {}
