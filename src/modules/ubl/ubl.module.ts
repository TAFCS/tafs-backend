import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { VouchersModule } from '../vouchers/vouchers.module';
import { UblController } from './ubl.controller';
import { UblReconciliationController } from './ubl-reconciliation.controller';
import { UblReconciliationService } from './ubl-reconciliation.service';
import { UblService } from './ubl.service';
import { UblAccessMiddleware } from './ubl-access.middleware';

@Module({
  imports: [VouchersModule, AuthModule],
  controllers: [UblController, UblReconciliationController],
  providers: [UblService, UblReconciliationService],
  exports: [UblService],
})
export class UblModule implements NestModule {
  /** TAFSD-548: IP allow-list and rate limit on UBL's bank-facing routes only (not the staff reconciliation reports). */
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(UblAccessMiddleware)
      .forRoutes(
        { path: 'ubl/bill-inquiry', method: RequestMethod.GET },
        { path: 'ubl/bill-payment', method: RequestMethod.POST },
      );
  }
}
