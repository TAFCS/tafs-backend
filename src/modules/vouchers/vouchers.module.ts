import { Module, forwardRef } from '@nestjs/common';
import { VouchersService } from './vouchers.service';
import { VouchersController } from './vouchers.controller';
import { DepositsController } from './deposits.controller';
import { VouchersSchedulerService } from './vouchers-scheduler.service';
import { VoucherNotificationService } from './voucher-notification.service';
import { VoucherNotificationSchedulerService } from './voucher-notification-scheduler.service';
import { VoucherNotificationsController } from './voucher-notifications.controller';
import { PrismaModule } from '../../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../../common/storage/storage.module';
import { FcmModule } from '../../common/fcm/fcm.module';
import { BulkVoucherJobsModule } from '../bulk-voucher-jobs/bulk-voucher-jobs.module';
import { VoucherPdfModule } from '../voucher-pdf/voucher-pdf.module';
import { BulkVoucherLogicService } from './bulk-voucher-logic.service';
import { ChatModule } from '../chat/chat.module';

@Module({
    imports: [PrismaModule, AuthModule, StorageModule, FcmModule, VoucherPdfModule, forwardRef(() => BulkVoucherJobsModule), forwardRef(() => ChatModule)],
    providers: [
        VouchersService,
        BulkVoucherLogicService,
        VouchersSchedulerService,
        VoucherNotificationService,
        VoucherNotificationSchedulerService,
    ],
    controllers: [VouchersController, DepositsController, VoucherNotificationsController],
    exports: [VouchersService, BulkVoucherLogicService, VouchersSchedulerService, VoucherNotificationService],
})
export class VouchersModule {}
