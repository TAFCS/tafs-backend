import { Module, forwardRef } from '@nestjs/common';
import { ParentChangeRequestsService } from './parent-change-requests.service';
import { ParentChangeRequestsController } from './parent-change-requests.controller';
import { PrismaModule } from '../../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [PrismaModule, forwardRef(() => AuthModule)],
  controllers: [ParentChangeRequestsController],
  providers: [ParentChangeRequestsService],
  exports: [ParentChangeRequestsService],
})
export class ParentChangeRequestsModule {}
