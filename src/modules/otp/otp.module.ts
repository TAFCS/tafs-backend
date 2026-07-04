import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../prisma/prisma.module';
import { MailerModule } from '../../common/mailer/mailer.module';
import { OtpService } from './otp.service';

@Module({
  imports: [PrismaModule, MailerModule],
  providers: [OtpService],
  exports: [OtpService],
})
export class OtpModule {}
