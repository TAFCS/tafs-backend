import { Module } from '@nestjs/common';
import { AppPortalController } from './app-portal.controller';
import { AppPortalService } from './app-portal.service';
import { PrismaModule } from '../../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [AppPortalController],
  providers: [AppPortalService],
  exports: [AppPortalService],
})
export class AppPortalModule {}
