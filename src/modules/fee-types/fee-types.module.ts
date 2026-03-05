import { Module } from '@nestjs/common';
import { FeeTypesController } from './fee-types.controller';
import { FeeTypesService } from './fee-types.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [FeeTypesController],
  providers: [FeeTypesService],
  exports: [FeeTypesService],
})
export class FeeTypesModule {}

