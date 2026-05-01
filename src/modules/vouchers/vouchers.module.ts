import { Module, forwardRef } from '@nestjs/common';
import { VouchersService } from './vouchers.service';
import { VouchersController } from './vouchers.controller';
import { PrismaModule } from '../../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../../common/storage/storage.module';
import { BulkVoucherJobsModule } from '../bulk-voucher-jobs/bulk-voucher-jobs.module';
import { VoucherPdfModule } from '../voucher-pdf/voucher-pdf.module';
import { BulkVoucherLogicService } from './bulk-voucher-logic.service';

@Module({
    imports: [PrismaModule, AuthModule, StorageModule, VoucherPdfModule, forwardRef(() => BulkVoucherJobsModule)],
    providers: [VouchersService, BulkVoucherLogicService],
    controllers: [VouchersController],
    exports: [VouchersService, BulkVoucherLogicService],
})
export class VouchersModule {}
