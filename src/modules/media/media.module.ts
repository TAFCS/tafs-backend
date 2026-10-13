import { Module } from '@nestjs/common';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { StorageModule } from '../../common/storage/storage.module';
import { PrismaModule } from '../../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { JwtStaffOrParentGuard } from '../../common/guards/jwt-staff-or-parent.guard';

@Module({
  imports: [StorageModule, PrismaModule, AuthModule],
  controllers: [MediaController],
  providers: [MediaService, JwtStaffOrParentGuard],
  exports: [MediaService],
})
export class MediaModule {}
