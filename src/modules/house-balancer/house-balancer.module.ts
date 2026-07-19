import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { HouseBalancerController } from './house-balancer.controller';
import { HouseBalancerService } from './house-balancer.service';

@Module({
  imports: [AuthModule],
  controllers: [HouseBalancerController],
  providers: [HouseBalancerService],
})
export class HouseBalancerModule {}
