import { Module } from '@nestjs/common';
import { FeeTypesController } from './fee-types.controller';
import { FeeTypesService } from './fee-types.service';
import { AuthModule } from '../auth/auth.module';
import { BundleNamesController } from './bundle-names.controller';
import { BundleNamesService } from './bundle-names.service';

@Module({
  imports: [AuthModule],
  controllers: [FeeTypesController, BundleNamesController],
  providers: [FeeTypesService, BundleNamesService],
  exports: [FeeTypesService, BundleNamesService],
})
export class FeeTypesModule {}

