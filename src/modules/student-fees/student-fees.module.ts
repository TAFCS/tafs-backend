import { Module } from '@nestjs/common';
import { StudentFeesService } from './student-fees.service';
import { StudentFeesController } from './student-fees.controller';
import { ParentStudentFeesController } from './parent-student-fees.controller';
import { PrismaModule } from '../../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { StudentsModule } from '../students/students.module';

@Module({
    imports: [PrismaModule, AuthModule, StudentsModule],
    providers: [StudentFeesService],
    controllers: [StudentFeesController, ParentStudentFeesController],
    exports: [StudentFeesService],
})
export class StudentFeesModule { }
