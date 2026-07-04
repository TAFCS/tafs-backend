import { Injectable, OnModuleInit } from '@nestjs/common';
import Mailjet from 'node-mailjet';

type OtpEmailPurpose = 'signup' | 'forgot-password';

@Injectable()
export class MailerService implements OnModuleInit {
  private client: Mailjet | null = null;
  private fromEmail: string;
  private fromName: string;

  onModuleInit() {
    const apiKey = process.env.MAILJET_API_KEY;
    const apiSecret = process.env.MAILJET_API_SECRET;
    this.fromEmail = process.env.MAILJET_FROM_EMAIL || 'noreply@tafs.edu.pk';
    this.fromName = process.env.MAILJET_FROM_NAME || 'TAFS';

    if (!apiKey || !apiSecret) {
      console.warn(
        '[Mailer] MAILJET_API_KEY / MAILJET_API_SECRET not set — email sending disabled.',
      );
      return;
    }

    try {
      this.client = Mailjet.apiConnect(apiKey, apiSecret);
      console.log('[Mailer] Mailjet client initialized');
    } catch (e) {
      console.warn('[Mailer] Failed to initialize Mailjet client:', e.message);
    }
  }

  async sendOtpEmail(
    to: string,
    code: string,
    purpose: OtpEmailPurpose,
  ): Promise<void> {
    if (!this.client) {
      console.error(
        `[Mailer] Mailjet not initialized — cannot send OTP to ${to}`,
      );
      return;
    }

    const isSignup = purpose === 'signup';
    const subject = isSignup
      ? 'TAFS — Verify your email'
      : 'TAFS — Password reset code';
    const heading = isSignup
      ? 'Verify Your Email Address'
      : 'Reset Your Password';
    const instruction = isSignup
      ? 'Use the code below to complete your account registration:'
      : 'Use the code below to reset your password:';

    const htmlBody = `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #1a1a1a; margin-bottom: 8px;">${heading}</h2>
        <p style="color: #555; font-size: 14px;">${instruction}</p>
        <div style="background: #f4f4f5; border-radius: 8px; padding: 20px; text-align: center; margin: 24px 0;">
          <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #1a1a1a;">${code}</span>
        </div>
        <p style="color: #888; font-size: 12px;">This code expires in 10 minutes. If you didn't request this, you can safely ignore this email.</p>
      </div>
    `;

    try {
      await this.client.post('send', { version: 'v3.1' }).request({
        Messages: [
          {
            From: { Email: this.fromEmail, Name: this.fromName },
            To: [{ Email: to }],
            Subject: subject,
            HTMLPart: htmlBody,
          },
        ],
      });
      console.log(`[Mailer] OTP email sent to ${to} (purpose=${purpose})`);
    } catch (e) {
      console.error(`[Mailer] Failed to send OTP email to ${to}:`, e.message);
    }
  }
}
