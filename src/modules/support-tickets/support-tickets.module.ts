import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { ChatModule } from '../chat/chat.module';
import { FcmModule } from '../../common/fcm/fcm.module';
import { SupportTicketsController } from './support-tickets.controller';
import { SupportTicketsService } from './support-tickets.service';
import { TicketRoutingService } from './routing/ticket-routing.service';
import { TicketRoutingAdminService } from './routing/ticket-routing-admin.service';
import { TicketRoutingAdminController } from './routing/ticket-routing-admin.controller';
import { JwtStaffOrParentGuard } from '../../common/guards/jwt-staff-or-parent.guard';

@Module({
  imports: [
    PrismaModule,
    forwardRef(() => AuthModule),
    FcmModule,
    forwardRef(() => ChatModule),
  ],
  controllers: [SupportTicketsController, TicketRoutingAdminController],
  providers: [SupportTicketsService, TicketRoutingService, TicketRoutingAdminService, JwtStaffOrParentGuard],
  exports: [SupportTicketsService, TicketRoutingService],
})
export class SupportTicketsModule {}
