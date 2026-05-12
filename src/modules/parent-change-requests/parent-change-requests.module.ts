import { Module } from '@nestjs/common';
import { ParentChangeRequestsService } from './parent-change-requests.service';
import { ParentChangeRequestsController } from './parent-change-requests.controller';
import { PrismaModule } from '../../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [ParentChangeRequestsController],
  providers: [ParentChangeRequestsService],
  exports: [ParentChangeRequestsService],
})
export class ParentChangeRequestsModule {}
