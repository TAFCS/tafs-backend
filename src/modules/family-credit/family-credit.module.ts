import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { FamilyCreditController } from './family-credit.controller';
import { FamilyCreditService } from './family-credit.service';

/** TAFSD-504: the Family Credit tile. Ledger rules live in vouchers/family-credit.ts. */
@Module({
    imports: [PrismaModule, AuthModule],
    controllers: [FamilyCreditController],
    providers: [FamilyCreditService],
    exports: [FamilyCreditService],
})
export class FamilyCreditModule {}
