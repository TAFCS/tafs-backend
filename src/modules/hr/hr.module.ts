import { Module } from '@nestjs/common';
import { EmployeesController } from './employees/employees.controller';
import { EmployeesSelfController } from './employees/employees-self.controller';
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
import { PayrollSelfController } from './payroll/payroll-self.controller';
import { PayrollMatrixController } from './payroll/payroll-matrix.controller';
import { PayrollService } from './payroll/payroll.service';
import { PayslipPdfService } from './payroll/payslip-pdf/payslip-pdf.service';
import { EmployeeProfileResolverService } from './employee-profile-resolver.service';
import { LeavesModule } from './leaves/leaves.module';
import { SaturdaySchedulesModule } from './saturday-schedules/saturday-schedules.module';
import { ShiftOverridesModule } from './shift-overrides/shift-overrides.module';
import { TimetablesModule } from '../timetables/timetables.module';
import { StorageModule } from '../../common/storage/storage.module';

@Module({
  imports: [AuthModule, FcmModule, LeavesModule, SaturdaySchedulesModule, ShiftOverridesModule, TimetablesModule, StorageModule],
  controllers: [
    EmployeesSelfController,
    EmployeesController,
    DepartmentsController,
    PoliciesController,
    CalendarController,
    ClassAttendanceModesController,
    StaffTypesController,
    CalendarNotificationsController,
    PayrollController,
    PayrollSelfController,
    PayrollMatrixController,
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
    PayslipPdfService,
    EmployeeProfileResolverService,
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
    PayslipPdfService,
    EmployeeProfileResolverService,
  ],
})
export class HrModule {}
