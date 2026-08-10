import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TimetablesController } from './timetables.controller';
import { TimetablesService } from './timetables.service';
import { SubjectsController } from './subjects.controller';
import { SubjectsService } from './subjects.service';
import { TeacherCheckinDerivationService } from './teacher-checkin-derivation.service';
import { EmployeeExpectedTimesService } from './employee-expected-times.service';
import { TeachingGroupsController } from './teaching-groups.controller';
import { TeachingGroupsService } from './teaching-groups.service';

@Module({
  imports: [AuthModule],
  controllers: [TimetablesController, SubjectsController, TeachingGroupsController],
  providers: [
    TimetablesService,
    SubjectsService,
    TeacherCheckinDerivationService,
    EmployeeExpectedTimesService,
    TeachingGroupsService,
  ],
  exports: [
    TimetablesService,
    SubjectsService,
    TeacherCheckinDerivationService,
    EmployeeExpectedTimesService,
    TeachingGroupsService,
  ],
})
export class TimetablesModule {}
