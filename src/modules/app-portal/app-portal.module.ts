import { Module } from '@nestjs/common';
import { AppPortalController } from './app-portal.controller';
import { AppPortalService } from './app-portal.service';
import { PrismaModule } from '../../../prisma/prisma.module';
import { HrModule } from '../hr/hr.module';

@Module({
  imports: [PrismaModule, HrModule],
  controllers: [AppPortalController],
  providers: [AppPortalService],
  exports: [AppPortalService],
})
export class AppPortalModule {}
