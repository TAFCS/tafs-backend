import { Controller, Get, Post, Delete, Param, UseGuards, HttpStatus, Res, Query } from '@nestjs/common';
import { BackupsService } from './backups.service';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { createApiResponse } from '../../utils/serializer.util';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';

@Controller('backups')
@UseGuards(JwtStaffGuard)
export class BackupsController {
    constructor(private readonly backupsService: BackupsService) {}

    @Get()
    async listBackups() {
        const backups = await this.backupsService.listBackups();
        return createApiResponse(backups, HttpStatus.OK, 'Backups retrieved successfully');
    }

    @Post('trigger')
    async triggerBackup(@CurrentUser() user: IJwtStaffPayload) {
        const result = await this.backupsService.createBackup(user.username);
        return createApiResponse(result, HttpStatus.CREATED, 'Dual-mode backup (SQL + JSON) triggered successfully');
    }

    @Get('download/*key')
    async downloadBackup(@Param('key') key: string | string[], @Res() res: any) {
        // Sometimes wildcard parameters can come in as arrays if there are multiple slashes
        const rawKey = Array.isArray(key) ? key.join('/') : key;
        const decodedKey = decodeURIComponent(rawKey).replace(/,/g, '/');
        
        try {
            const { buffer, mime } = await this.backupsService.getFileData(decodedKey);
            const fileName = decodedKey.split('/').pop() || 'backup.sql.gz';
            
            res.setHeader('Content-Type', mime);
            res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
            res.send(buffer);
        } catch (error) {
            return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
                message: 'Failed to download backup: ' + error.message
            });
        }
    }

    @Delete('delete/*key')
    async deleteBackup(@Param('key') key: string | string[], @CurrentUser() user: IJwtStaffPayload) {
        const rawKey = Array.isArray(key) ? key.join('/') : key;
        const decodedKey = decodeURIComponent(rawKey).replace(/,/g, '/');
        await this.backupsService.deleteBackup(decodedKey, user.username);
        return createApiResponse(null, HttpStatus.OK, 'Backup deleted successfully');
    }
}
