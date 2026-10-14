import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BackupsService } from './backups.service';

@Injectable()
export class BackupsSchedulerService {
    private readonly logger = new Logger(BackupsSchedulerService.name);

    constructor(private readonly backupsService: BackupsService) {}

    /**
     * Automated Database Backup
     * Runs twice a day, Pakistan Time (PKT): 4:00 PM, after school hours, and
     * 12:00 AM. A backup reads every table in-process for about 75 s, so it
     * stays out of the busy school day (TAFSD-326).
     */
    @Cron('0 0,16 * * *', {
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
