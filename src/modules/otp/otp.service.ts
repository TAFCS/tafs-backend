import { Injectable, BadRequestException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { MailerService } from '../../common/mailer/mailer.service';
import { otp_purpose } from '@prisma/client';

const OTP_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
const RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds
const BCRYPT_ROUNDS = 10;

interface IssueParams {
  purpose: otp_purpose;
  email: string;
  familyId?: number;
  userId?: string;
  cnic?: string;
}

interface VerifyResult {
  familyId?: number;
  userId?: string;
}

@Injectable()
export class OtpService {
  constructor(
    private prisma: PrismaService,
    private mailerService: MailerService,
  ) {}

  private generateCode(): string {
    return crypto.randomInt(1000, 10000).toString();
  }

  async issue(params: IssueParams): Promise<void> {
    const { purpose, email, familyId, userId, cnic } = params;
    const normalizedEmail = email.toLowerCase().trim();

    const code = this.generateCode();
    const codeHash = await bcrypt.hash(code, BCRYPT_ROUNDS);

    await this.prisma.$transaction(async (tx) => {
      // Enforce resend cooldown
      const recentCode = await tx.otp_codes.findFirst({
        where: {
          email: normalizedEmail,
          purpose,
          consumed_at: null,
          created_at: { gt: new Date(Date.now() - RESEND_COOLDOWN_MS) },
        },
        orderBy: { created_at: 'desc' },
      });

      if (recentCode) {
        throw new BadRequestException(
          'Please wait 60 seconds before requesting a new code.',
        );
      }

      // Invalidate any prior unconsumed codes for the same (email, purpose)
      await tx.otp_codes.updateMany({
        where: {
          email: normalizedEmail,
          purpose,
          consumed_at: null,
        },
        data: { consumed_at: new Date() },
      });

      await tx.otp_codes.create({
        data: {
          id: crypto.randomUUID(),
          purpose,
          email: normalizedEmail,
          code_hash: codeHash,
          expires_at: new Date(Date.now() + OTP_EXPIRY_MS),
          ...(familyId != null && { family_id: familyId }),
          ...(userId != null && { user_id: userId }),
          ...(cnic != null && { cnic }),
        },
      });
    });

    const emailPurpose =
      purpose === otp_purpose.PARENT_SIGNUP ? 'signup' : 'forgot-password';
    await this.mailerService.sendOtpEmail(normalizedEmail, code, emailPurpose);
  }

  async verify(params: {
    purpose: otp_purpose;
    email: string;
    code: string;
  }): Promise<VerifyResult> {
    const { purpose, code } = params;
    const normalizedEmail = params.email.toLowerCase().trim();

    const otpRecord = await this.prisma.otp_codes.findFirst({
      where: {
        email: normalizedEmail,
        purpose,
        consumed_at: null,
        expires_at: { gt: new Date() },
      },
      orderBy: { created_at: 'desc' },
    });

    if (!otpRecord) {
      throw new BadRequestException('Invalid or expired code');
    }

    if (otpRecord.attempts >= otpRecord.max_attempts) {
      throw new BadRequestException(
        'Too many incorrect attempts. Please request a new code.',
      );
    }

    const isMatch = await bcrypt.compare(code, otpRecord.code_hash);

    if (!isMatch) {
      await this.prisma.otp_codes.update({
        where: { id: otpRecord.id },
        data: { attempts: { increment: 1 } },
      });
      throw new BadRequestException('Invalid or expired code');
    }

    // Mark as consumed
    await this.prisma.otp_codes.update({
      where: { id: otpRecord.id },
      data: { consumed_at: new Date() },
    });

    return {
      familyId: otpRecord.family_id ?? undefined,
      userId: otpRecord.user_id ?? undefined,
    };
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async cleanupExpiredCodes() {
    const result = await this.prisma.otp_codes.deleteMany({
      where: {
        expires_at: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    });
    if (result.count > 0) {
      console.log(`[OTP] Cleaned up ${result.count} expired OTP code(s)`);
    }
  }
}
