import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ApiDocsController } from './api-docs.controller';
import { ApiDocsService } from './api-docs.service';

@Module({
  imports: [AuthModule],
  controllers: [ApiDocsController],
  providers: [ApiDocsService],
})
export class ApiDocsModule {}
