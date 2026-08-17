import { Injectable, OnModuleInit } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

type OtpEmailPurpose = 'signup' | 'forgot-password';

@Injectable()
export class MailerService implements OnModuleInit {
  private transporter: Transporter | null = null;
  private fromEmail: string;
  private fromName: string;

  onModuleInit() {
    const host = process.env.BREVO_SMTP_HOST || 'smtp-relay.brevo.com';
    const port = Number(process.env.BREVO_SMTP_PORT || 587);
    const user = process.env.BREVO_SMTP_USER;
    const pass = process.env.BREVO_SMTP_KEY;
    this.fromEmail =
      process.env.BREVO_FROM_EMAIL || 'no-reply@snaeducationalservices.com';
    this.fromName = process.env.BREVO_FROM_NAME || 'TAFS';

    if (!user || !pass) {
      console.warn(
        '[Mailer] BREVO_SMTP_USER / BREVO_SMTP_KEY not set — email sending disabled.',
      );
      return;
    }

    try {
      this.transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
      });
      console.log('[Mailer] Brevo SMTP transporter initialized');
    } catch (e) {
      console.warn(
        '[Mailer] Failed to initialize Brevo SMTP transporter:',
        e.message,
      );
    }
  }

  async sendDailyDigestEmail(
    to: string[],
    data: {
      dateLabel: string;
      depositsTotal: string;
      depositsCount: number;
      employeesClockedIn: number;
      employeesClockedOut: number;
      studentsClockedIn: number;
      studentsClockedOut: number;
    },
  ): Promise<void> {
    if (!this.transporter) {
      console.error(
        '[Mailer] Brevo SMTP not initialized — cannot send daily digest',
      );
      return;
    }
    if (to.length === 0) return;

    const subject = `TAFS — Daily Digest for ${data.dateLabel}`;
    const row = (label: string, value: string) => `
        <tr>
          <td style="padding: 10px 0; color: #555; font-size: 14px; border-bottom: 1px solid #eee;">${label}</td>
          <td style="padding: 10px 0; color: #1a1a1a; font-size: 14px; font-weight: bold; text-align: right; border-bottom: 1px solid #eee;">${value}</td>
        </tr>`;

    const htmlBody = `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #1a1a1a; margin-bottom: 4px;">Daily Digest</h2>
        <p style="color: #888; font-size: 13px; margin-top: 0;">${data.dateLabel}</p>
        <table style="width: 100%; border-collapse: collapse; margin-top: 16px;">
          ${row('Money deposited today', `${data.depositsTotal} (${data.depositsCount} deposit${data.depositsCount === 1 ? '' : 's'})`)}
          ${row('Employees clocked in', String(data.employeesClockedIn))}
          ${row('Employees clocked out', String(data.employeesClockedOut))}
          ${row('Students clocked in', String(data.studentsClockedIn))}
          ${row('Students clocked out', String(data.studentsClockedOut))}
        </table>
      </div>
    `;

    try {
      const info = await this.transporter.sendMail({
        from: `${this.fromName} <${this.fromEmail}>`,
        to,
        subject,
        html: htmlBody,
      });
      console.log(
        `[Mailer] Daily digest sent to ${to.join(', ')} (id=${info.messageId})`,
      );
    } catch (e) {
      console.error('[Mailer] Failed to send daily digest:', e.message);
      throw e;
    }
  }

  async sendOtpEmail(
    to: string,
    code: string,
    purpose: OtpEmailPurpose,
  ): Promise<void> {
    if (!this.transporter) {
      console.error(
        `[Mailer] Brevo SMTP not initialized — cannot send OTP to ${to}`,
      );
      throw new Error('Email service is not configured');
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
      const info = await this.transporter.sendMail({
        from: `${this.fromName} <${this.fromEmail}>`,
        to,
        subject,
        html: htmlBody,
      });
      console.log(
        `[Mailer] OTP email sent to ${to} (purpose=${purpose}, id=${info.messageId})`,
      );
    } catch (e) {
      console.error(`[Mailer] Failed to send OTP email to ${to}:`, e.message);
      throw e;
    }
  }
}
