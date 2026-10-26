import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BackupsService } from './backups.service';

@Injectable()
export class BackupsSchedulerService {
    private readonly logger = new Logger(BackupsSchedulerService.name);

    constructor(private readonly backupsService: BackupsService) {}

    /**
     * Automated Database Backup
     * Runs twice a day, Pakistan Time (PKT): 4:00 PM and 12:00 AM.
     * SQL-only (pg_dump child process). Dual JSON dumps are opt-in via the
     * admin trigger — loading every table through Prisma OOMed prod.
     */
    @Cron('0 0,16 * * *', {
        timeZone: 'Asia/Karachi',
    })
    async handleAutomatedBackup() {
        this.logger.log('[Backup Scheduler] Starting scheduled SQL backup (PKT)...');
        try {
            const result = await this.backupsService.createBackup();
            this.logger.log(
                `[Backup Scheduler] Scheduled backup completed: ${result.sql.fileName}`,
            );
        } catch (error: any) {
            this.logger.error(`[Backup Scheduler] Scheduled backup failed: ${error.message}`);
            await this.backupsService.notifyBackupFailure('scheduled-job', error.message);
        }
    }
}
