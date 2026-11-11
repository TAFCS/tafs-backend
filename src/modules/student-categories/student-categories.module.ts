import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { StudentCategoriesController } from './student-categories.controller';
import { StudentCategoriesService } from './student-categories.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [StudentCategoriesController],
  providers: [StudentCategoriesService],
  exports: [StudentCategoriesService],
})
export class StudentCategoriesModule {}
