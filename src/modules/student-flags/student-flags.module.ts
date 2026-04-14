import { Module } from '@nestjs/common';
import { StudentFlagsService } from './student-flags.service';
import { StudentFlagsController } from './student-flags.controller';
import { PrismaModule } from '../../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [StudentFlagsController],
  providers: [StudentFlagsService],
  exports: [StudentFlagsService],
})
export class StudentFlagsModule {}
