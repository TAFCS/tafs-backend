import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TimetablesController } from './timetables.controller';
import { TimetablesService } from './timetables.service';
import { SubjectsController } from './subjects.controller';
import { SubjectsService } from './subjects.service';
import { TeacherCheckinDerivationService } from './teacher-checkin-derivation.service';
import { EmployeeExpectedTimesService } from './employee-expected-times.service';

@Module({
  imports: [AuthModule],
  controllers: [TimetablesController, SubjectsController],
  providers: [
    TimetablesService,
    SubjectsService,
    TeacherCheckinDerivationService,
    EmployeeExpectedTimesService,
  ],
  exports: [
    TimetablesService,
    SubjectsService,
    TeacherCheckinDerivationService,
    EmployeeExpectedTimesService,
  ],
})
export class TimetablesModule {}
