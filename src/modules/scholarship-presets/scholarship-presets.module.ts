import { Module } from '@nestjs/common';
import { ScholarshipPresetsController } from './scholarship-presets.controller';
import { ScholarshipPresetsService } from './scholarship-presets.service';
import { AuthModule } from '../auth/auth.module';

@Module({
    imports: [AuthModule],
    controllers: [ScholarshipPresetsController],
    providers: [ScholarshipPresetsService],
    exports: [ScholarshipPresetsService],
})
export class ScholarshipPresetsModule {}
