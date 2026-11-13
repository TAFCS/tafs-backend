import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { VouchersModule } from '../vouchers/vouchers.module';
import { UblController } from './ubl.controller';
import { UblReconciliationController } from './ubl-reconciliation.controller';
import { UblReconciliationService } from './ubl-reconciliation.service';
import { UblService } from './ubl.service';

@Module({
  imports: [VouchersModule, AuthModule],
  controllers: [UblController, UblReconciliationController],
  providers: [UblService, UblReconciliationService],
  exports: [UblService],
})
export class UblModule {}
