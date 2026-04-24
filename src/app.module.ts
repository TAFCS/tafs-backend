import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
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
import { TransferModule } from './modules/transfers/transfer.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { AppPortalModule } from './modules/app-portal/app-portal.module';
import { InstallmentsModule } from './modules/installments/installments.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
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
    TransferModule,
    AnalyticsModule,
    AppPortalModule,
    InstallmentsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }
