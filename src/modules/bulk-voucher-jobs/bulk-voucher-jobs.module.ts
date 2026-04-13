import { Module } from '@nestjs/common';
import { BulkVoucherJobsService } from './bulk-voucher-jobs.service';
import { BulkVoucherJobsController } from './bulk-voucher-jobs.controller';
import { PrismaModule } from '../../../prisma/prisma.module';
import { VouchersModule } from '../vouchers/vouchers.module';
import { VoucherPdfModule } from '../voucher-pdf/voucher-pdf.module';
import { StorageModule } from '../../common/storage/storage.module';

@Module({
    imports: [PrismaModule, VouchersModule, StorageModule, VoucherPdfModule],
    providers: [BulkVoucherJobsService],
    controllers: [BulkVoucherJobsController],
    exports: [BulkVoucherJobsService],
})
export class BulkVoucherJobsModule {}
