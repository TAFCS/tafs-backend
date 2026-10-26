import { Module } from '@nestjs/common';
import { BackupsService } from './backups.service';
import { BackupsController } from './backups.controller';
import { BackupsSchedulerService } from './backups-scheduler.service';
import { StorageModule } from '../../common/storage/storage.module';
import { FcmModule } from '../../common/fcm/fcm.module';

@Module({
    imports: [StorageModule, FcmModule],
    controllers: [BackupsController],
    providers: [BackupsService, BackupsSchedulerService],
    exports: [BackupsService],
})
export class BackupsModule {}
