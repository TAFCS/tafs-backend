import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { HouseBalancerController } from './house-balancer.controller';
import { HouseBalancerService } from './house-balancer.service';
import { ProgressionHistoryModule } from '../students/progression-history.module';

@Module({
  imports: [AuthModule, ProgressionHistoryModule],
  controllers: [HouseBalancerController],
  providers: [HouseBalancerService],
})
export class HouseBalancerModule {}
