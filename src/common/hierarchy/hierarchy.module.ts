import { Global, Module } from '@nestjs/common';
import { HierarchyService } from './hierarchy.service';

/**
 * Global so any service across HR, support tickets, approvals, and scope
 * can inject HierarchyService without importing a module.
 */
@Global()
@Module({
  providers: [HierarchyService],
  exports: [HierarchyService],
})
export class HierarchyModule {}
