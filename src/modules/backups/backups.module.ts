import { Module } from '@nestjs/common';
import { BackupsService } from './backups.service';
import { BackupsController } from './backups.controller';
import { BackupsSchedulerService } from './backups-scheduler.service';
import { StorageModule } from '../../common/storage/storage.module';

@Module({
    imports: [StorageModule],
    controllers: [BackupsController],
    providers: [BackupsService, BackupsSchedulerService],
    exports: [BackupsService],
})
export class BackupsModule {}
