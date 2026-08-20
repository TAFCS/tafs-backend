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
import { TimetablesSelfController } from './timetables-self.controller';
import { TimetablesParentController } from './timetables-parent.controller';
import { ClassPeriodsService } from './class-periods.service';

@Module({
  imports: [AuthModule],
  controllers: [
    TimetablesController,
    SubjectsController,
    TeachingGroupsController,
    TimetablesSelfController,
    TimetablesParentController,
  ],
  providers: [
    TimetablesService,
    SubjectsService,
    TeacherCheckinDerivationService,
    EmployeeExpectedTimesService,
    TeachingGroupsService,
    ClassPeriodsService,
  ],
  exports: [
    TimetablesService,
    SubjectsService,
    TeacherCheckinDerivationService,
    EmployeeExpectedTimesService,
    TeachingGroupsService,
    ClassPeriodsService,
  ],
})
export class TimetablesModule {}
