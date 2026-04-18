import { Module } from '@nestjs/common';
import { TransferController } from './transfer.controller';
import { TransferService } from './transfer.service';
import { PrismaModule } from '../../../prisma/prisma.module';
import { StorageModule } from '../../common/storage/storage.module';
import { VoucherPdfModule } from '../voucher-pdf/voucher-pdf.module';

@Module({
  imports: [PrismaModule, StorageModule, VoucherPdfModule],
  controllers: [TransferController],
  providers: [TransferService],
})
export class TransferModule {}
