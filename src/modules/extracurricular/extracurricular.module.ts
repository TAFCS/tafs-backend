import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { EcChargesController } from './charges/ec-charges.controller';
import { EcChargesService } from './charges/ec-charges.service';
import { EcClassScheduleController } from './class-schedule/ec-class-schedule.controller';
import { EcClassScheduleService } from './class-schedule/ec-class-schedule.service';
import { EcFeeHeadsController } from './fee-heads/ec-fee-heads.controller';
import { EcFeeHeadsService } from './fee-heads/ec-fee-heads.service';

/**
 * TAFSD-605: Extracurricular Fees. A billing flow of its own, kept apart from
 * academic fees: own heads, class amounts, student charges, vouchers and
 * deposits on the ec_* tables. Rules: ./CLAUDE.md.
 */
@Module({
    imports: [PrismaModule, AuthModule],
    controllers: [EcFeeHeadsController, EcClassScheduleController, EcChargesController],
    providers: [EcFeeHeadsService, EcClassScheduleService, EcChargesService],
    exports: [EcChargesService],
})
export class ExtracurricularModule {}
