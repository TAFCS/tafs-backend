import { Module } from '@nestjs/common';
import { EmployeesController } from './employees/employees.controller';
import { EmployeesService } from './employees/employees.service';
import { DepartmentsController } from './departments/departments.controller';
import { DepartmentsService } from './departments/departments.service';
import { PoliciesController } from './policies/policies.controller';
import { PoliciesService } from './policies/policies.service';
import { CalendarController } from './calendar/calendar.controller';
import { CalendarService } from './calendar/calendar.service';
import { CalendarDayResolverService } from './calendar/calendar-day-resolver.service';
import { HolidayAttendanceSyncService } from './calendar/holiday-attendance-sync.service';
import { HolidayAttendanceSchedulerService } from './calendar/holiday-attendance-scheduler.service';
import { ClassAttendanceModesController } from './class-attendance-modes/class-attendance-modes.controller';
import { ClassAttendanceModesService } from './class-attendance-modes/class-attendance-modes.service';
import { StaffTypesController } from './staff-types/staff-types.controller';
import { StaffTypesService } from './staff-types/staff-types.service';
import { AuthModule } from '../auth/auth.module';
import { FcmModule } from '../../common/fcm/fcm.module';
import { CalendarNotificationService } from './calendar/calendar-notification.service';
import { CalendarNotificationsController } from './calendar/calendar-notifications.controller';
import { PayrollController } from './payroll/payroll.controller';
import { PayrollService } from './payroll/payroll.service';

@Module({
  imports: [AuthModule, FcmModule],
  controllers: [
    EmployeesController,
    DepartmentsController,
    PoliciesController,
    CalendarController,
    ClassAttendanceModesController,
    StaffTypesController,
    CalendarNotificationsController,
    PayrollController,
  ],
  providers: [
    EmployeesService,
    DepartmentsService,
    PoliciesService,
    CalendarService,
    CalendarDayResolverService,
    HolidayAttendanceSyncService,
    HolidayAttendanceSchedulerService,
    ClassAttendanceModesService,
    StaffTypesService,
    CalendarNotificationService,
    PayrollService,
  ],
  exports: [
    EmployeesService,
    DepartmentsService,
    PoliciesService,
    CalendarService,
    CalendarDayResolverService,
    HolidayAttendanceSyncService,
    ClassAttendanceModesService,
    StaffTypesService,
    CalendarNotificationService,
    PayrollService,
  ],
})
export class HrModule {}
