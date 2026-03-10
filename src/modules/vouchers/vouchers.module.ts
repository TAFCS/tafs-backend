import { Module } from '@nestjs/common';
import { VouchersService } from './vouchers.service';
import { VouchersController } from './vouchers.controller';
import { PrismaModule } from '../../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';

@Module({
    imports: [PrismaModule, AuthModule],
    providers: [VouchersService],
    controllers: [VouchersController],
    exports: [VouchersService],
})
export class VouchersModule {}
