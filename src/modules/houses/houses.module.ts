import { Module } from '@nestjs/common';
import { HousesController } from './houses.controller';
import { HousesService } from './houses.service';
import { PrismaModule } from '../../../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { AuthModule } from '../auth/auth.module';

@Module({
<<<<<<< HEAD
=======
  // PoliciesGuard on the controller needs CaslAbilityFactory from AuthModule;
  // without it the whole app fails to boot.
>>>>>>> 1426b58c607a1b0435371105591a86ebe8d17209
  imports: [PrismaModule, AuditLogsModule, AuthModule],
  controllers: [HousesController],
  providers: [HousesService],
  exports: [HousesService],
})
export class HousesModule {}
