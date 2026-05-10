import { Module } from '@nestjs/common';
import { DiscountPresetsController } from './discount-presets.controller';
import { DiscountPresetsService } from './discount-presets.service';
import { AuthModule } from '../auth/auth.module';

@Module({
    imports: [AuthModule],
    controllers: [DiscountPresetsController],
    providers: [DiscountPresetsService],
    exports: [DiscountPresetsService],
})
export class DiscountPresetsModule {}
