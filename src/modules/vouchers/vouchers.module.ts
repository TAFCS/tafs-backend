import { Module } from '@nestjs/common';
import { VouchersService } from './vouchers.service';
import { VouchersController } from './vouchers.controller';
import { PrismaModule } from '../../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../../common/storage/storage.module';

@Module({
    imports: [PrismaModule, AuthModule, StorageModule],
    providers: [VouchersService],
    controllers: [VouchersController],
    exports: [VouchersService],
})
export class VouchersModule {}
