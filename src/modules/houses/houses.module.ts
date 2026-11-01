import { Module } from '@nestjs/common';
import { HousesController } from './houses.controller';
import { HousesService } from './houses.service';
import { PrismaModule } from '../../../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  // PoliciesGuard on the controller needs CaslAbilityFactory from AuthModule;
  // without it the whole app fails to boot.
  imports: [PrismaModule, AuditLogsModule, AuthModule],
  controllers: [HousesController],
  providers: [HousesService],
  exports: [HousesService],
})
export class HousesModule {}
