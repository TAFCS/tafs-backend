import { Module } from '@nestjs/common';
import { HousesController } from './houses.controller';
import { HousesService } from './houses.service';
import { PrismaModule } from '../../../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';

@Module({
  imports: [PrismaModule, AuditLogsModule],
  controllers: [HousesController],
  providers: [HousesService],
  exports: [HousesService],
})
export class HousesModule {}
