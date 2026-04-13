import { Module } from '@nestjs/common';
import { VoucherPdfService } from './voucher-pdf.service';

@Module({
    providers: [VoucherPdfService],
    exports: [VoucherPdfService],
})
export class VoucherPdfModule {}
