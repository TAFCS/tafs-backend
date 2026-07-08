import { Module } from '@nestjs/common';
import { UnconfirmedAdmissionsController } from './unconfirmed-admissions.controller';
import { UnconfirmedAdmissionsService } from './unconfirmed-admissions.service';
import { StorageModule } from '../../common/storage/storage.module';
import { PrismaModule } from '../../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [StorageModule, PrismaModule, AuthModule],
  controllers: [UnconfirmedAdmissionsController],
  providers: [UnconfirmedAdmissionsService],
  exports: [UnconfirmedAdmissionsService],
})
export class UnconfirmedAdmissionsModule {}
