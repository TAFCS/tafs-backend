import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { AccessModule } from '../access/access.module';
import { AuthModule } from '../auth/auth.module';
import { StaffNotificationsModule } from '../staff-notifications/staff-notifications.module';
import { UniformPhotosController } from './uniform-photos.controller';
import { UniformPhotosSchedulerService } from './uniform-photos-scheduler.service';
import { UniformPhotosService } from './uniform-photos.service';

@Module({
  imports: [PrismaModule, AuthModule, AccessModule, StaffNotificationsModule],
  controllers: [UniformPhotosController],
  providers: [UniformPhotosService, UniformPhotosSchedulerService],
  exports: [UniformPhotosService],
})
export class UniformPhotosModule {}
