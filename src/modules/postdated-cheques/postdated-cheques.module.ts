import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { PostdatedChequesController } from './postdated-cheques.controller';
import { PostdatedChequesService } from './postdated-cheques.service';

@Module({
  imports: [PrismaModule],
  controllers: [PostdatedChequesController],
  providers: [PostdatedChequesService],
  exports: [PostdatedChequesService],
})
export class PostdatedChequesModule {}
