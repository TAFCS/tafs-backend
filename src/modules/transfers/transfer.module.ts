import { Module } from '@nestjs/common';
import { TransferController } from './transfer.controller';
import { TransferService } from './transfer.service';
import { PrismaModule } from '../../../prisma/prisma.module';
import { StorageModule } from '../../common/storage/storage.module';
import { VoucherPdfModule } from '../voucher-pdf/voucher-pdf.module';
import { StudentAllocationModule } from '../student-allocation/student-allocation.module';

@Module({
  imports: [PrismaModule, StorageModule, VoucherPdfModule, StudentAllocationModule],
  controllers: [TransferController],
  providers: [TransferService],
})
export class TransferModule {}
