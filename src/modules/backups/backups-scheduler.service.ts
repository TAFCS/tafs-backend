import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BackupsService } from './backups.service';

@Injectable()
export class BackupsSchedulerService {
    private readonly logger = new Logger(BackupsSchedulerService.name);

    constructor(private readonly backupsService: BackupsService) {}

    /**
     * Automated Database Backup
     * Runs at 12:00 AM, 12:00 PM, and 4:00 PM Pakistan Time (PKT)
     */
    @Cron('0 0,12,16 * * *', {
        timeZone: 'Asia/Karachi',
    })
    async handleAutomatedBackup() {
        this.logger.log('[Backup Scheduler] Starting scheduled database backup (PKT)...');
        try {
            const result = await this.backupsService.createBackup();
            this.logger.log(`[Backup Scheduler] Scheduled backup completed: ${result.sql.fileName} and ${result.json.fileName}`);
        } catch (error) {
            this.logger.error(`[Backup Scheduler] Scheduled backup failed: ${error.message}`);
        }
    }
}
