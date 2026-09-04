import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { IdentityModule } from './modules/identity/identity.module';
import { StudentsModule } from './modules/students/students.module';
import { FamiliesModule } from './modules/families/families.module';
import { ClassesModule } from './modules/classes/classes.module';
import { SectionsModule } from './modules/sections/sections.module';
import { FeeTypesModule } from './modules/fee-types/fee-types.module';
import { ClassFeeScheduleModule } from './modules/class-fee-schedule/class-fee-schedule.module';
import { FeesModule } from './modules/fees/fees.module';
import { StudentFeesModule } from './modules/student-fees/student-fees.module';
import { CampusesModule } from './modules/campuses/campuses.module';
import { StaffEditingModule } from './modules/staff-editing/staff-editing.module';
import { BankAccountsModule } from './modules/bank-accounts/bank-accounts.module';
import { VouchersModule } from './modules/vouchers/vouchers.module';
import { BulkVoucherJobsModule } from './modules/bulk-voucher-jobs/bulk-voucher-jobs.module';
import { EnrollmentModule } from './modules/enrollments/enrollment.module';
import { MediaModule } from './modules/media/media.module';
import { StudentFlagsModule } from './modules/student-flags/student-flags.module';
import { PostdatedChequesModule } from './modules/postdated-cheques/postdated-cheques.module';
import { TransferModule } from './modules/transfers/transfer.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { FinancialReportsModule } from './modules/financial-reports/financial-reports.module';
import { AppPortalModule } from './modules/app-portal/app-portal.module';
import { InstallmentsModule } from './modules/installments/installments.module';
import { MeezanModule } from './modules/meezan/meezan.module';
import { DiscountPresetsModule } from './modules/discount-presets/discount-presets.module';
import { ScholarshipPresetsModule } from './modules/scholarship-presets/scholarship-presets.module';
import { ParentChangeRequestsModule } from './modules/parent-change-requests/parent-change-requests.module';
import { ChatModule } from './modules/chat/chat.module';
import { SupportTicketsModule } from './modules/support-tickets/support-tickets.module';
import { BackupsModule } from './modules/backups/backups.module';
import { HrModule } from './modules/hr/hr.module';
import { AttendanceModule } from './modules/attendance/attendance.module';
import { NoticeBoardModule } from './modules/notice-board/notice-board.module';
import { EmployeeNoticeBoardModule } from './modules/employee-notice-board/employee-notice-board.module';
import { AppConfigModule } from './modules/app-config/app-config.module';
import { AuditLogsModule } from './modules/audit-logs/audit-logs.module';
import { TimetablesModule } from './modules/timetables/timetables.module';
import { UnconfirmedAdmissionsModule } from './modules/unconfirmed-admissions/unconfirmed-admissions.module';
import { HouseBalancerModule } from './modules/house-balancer/house-balancer.module';
import { StudentAllocationModule } from './modules/student-allocation/student-allocation.module';
import { DailyDigestModule } from './modules/daily-digest/daily-digest.module';
import { AccessModule } from './modules/access/access.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    UsersModule,
    AuthModule,
    IdentityModule,
    StudentsModule,
    FamiliesModule,
    ClassesModule,
    SectionsModule,
    FeeTypesModule,
    ClassFeeScheduleModule,
    FeesModule,
    StudentFeesModule,
    CampusesModule,
    StaffEditingModule,
    BankAccountsModule,
    VouchersModule,
    BulkVoucherJobsModule,
    EnrollmentModule,
    MediaModule,
    StudentFlagsModule,
    PostdatedChequesModule,
    TransferModule,
    AnalyticsModule,
    FinancialReportsModule,
    AppPortalModule,
    InstallmentsModule,
    MeezanModule,
    DiscountPresetsModule,
    ScholarshipPresetsModule,
    ParentChangeRequestsModule,
    ChatModule,
    SupportTicketsModule,
    BackupsModule,
    HrModule,
    AttendanceModule,
    TimetablesModule,
    NoticeBoardModule,
    EmployeeNoticeBoardModule,
    AppConfigModule,
    AuditLogsModule,
    UnconfirmedAdmissionsModule,
    StudentAllocationModule,
    HouseBalancerModule,
    DailyDigestModule,
    AccessModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }
