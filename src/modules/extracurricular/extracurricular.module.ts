import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { StorageModule } from '../../common/storage/storage.module';
import { AuthModule } from '../auth/auth.module';
import { VoucherPdfModule } from '../voucher-pdf/voucher-pdf.module';
import { EcChargesController } from './charges/ec-charges.controller';
import { EcChargesService } from './charges/ec-charges.service';
import { EcClassScheduleController } from './class-schedule/ec-class-schedule.controller';
import { EcClassScheduleService } from './class-schedule/ec-class-schedule.service';
import { EcDepositsController } from './deposits/ec-deposits.controller';
import { EcDepositsService } from './deposits/ec-deposits.service';
import { EcFeeHeadsController } from './fee-heads/ec-fee-heads.controller';
import { EcFeeHeadsService } from './fee-heads/ec-fee-heads.service';
import { EcVoucherPdfService } from './vouchers/ec-voucher-pdf.service';
import { EcVouchersController } from './vouchers/ec-vouchers.controller';
import { EcVouchersService } from './vouchers/ec-vouchers.service';

/**
 * TAFSD-605: Extracurricular Fees. A billing flow of its own, kept apart from
 * academic fees: own heads, class amounts, student charges, vouchers and
 * deposits on the ec_* tables. Rules: ./CLAUDE.md.
 *
 * VoucherPdfModule is shared on purpose: EC challans render as a named task on
 * the same worker pool, without changing how academic challans render.
 */
@Module({
    imports: [PrismaModule, AuthModule, StorageModule, VoucherPdfModule],
    controllers: [EcFeeHeadsController, EcClassScheduleController, EcChargesController, EcVouchersController, EcDepositsController],
    providers: [EcFeeHeadsService, EcClassScheduleService, EcChargesService, EcVouchersService, EcVoucherPdfService, EcDepositsService],
    exports: [EcChargesService, EcVouchersService, EcVoucherPdfService],
})
export class ExtracurricularModule {}
