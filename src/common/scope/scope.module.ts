import { Global, Module } from '@nestjs/common';
import { ScopeService } from './scope.service';

/**
 * Global so any service can inject ScopeService without importing a module —
 * the point is that there is exactly one implementation of scope enforcement.
 */
@Global()
@Module({
  providers: [ScopeService],
  exports: [ScopeService],
})
export class ScopeModule {}
