import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { FamiliesController } from './families.controller';
import { FamiliesService } from './families.service';
import { AuthModule } from '../auth/auth.module';
import { NormalizeQueryArraysMiddleware } from './normalize-query-arrays.middleware';

@Module({
  imports: [AuthModule],
  controllers: [FamiliesController],
  providers: [FamiliesService],
  exports: [FamiliesService],
})
export class FamiliesModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(NormalizeQueryArraysMiddleware)
      .forRoutes({ path: 'families', method: RequestMethod.GET });
  }
}
