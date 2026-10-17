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
     * 12:00 AM. JSON export used to sync-stringify the whole DB on the Nest
     * event loop (~75s) and freeze every route — it now streams with yields
     * (see BackupsService.createJsonBackup). Still kept off the school day.
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
