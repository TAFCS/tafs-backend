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
    const PRIMARY = '#255A94';
    const PRIMARY_TINT = '#EAF1F8';
    const PRIMARY_BORDER = '#C7D9EA';
    const BORDER = '#E4E4E7';
    const MUTED = '#71717A';
    const FOREGROUND = '#0F172A';

    const tile = (label: string, value: string) => `
              <td width="50%" valign="top" style="padding: 6px;">
                <div class="dd-tile" style="background: #ffffff; border: 1px solid ${BORDER}; border-radius: 16px; padding: 14px 16px;">
                  <div class="dd-muted" style="font-size: 11px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: ${MUTED};">${label}</div>
                  <div class="dd-fg" style="font-size: 22px; font-weight: 700; color: ${FOREGROUND}; margin-top: 4px;">${value}</div>
                </div>
              </td>`;

    // Gmail's mobile apps ignore the color-scheme meta tags below and will
    // auto-invert light-mode colors unless an explicit dark-mode override is
    // present in a <style> block — so we re-assert the same light palette
    // under prefers-color-scheme: dark to defeat that auto-inversion.
    const htmlBody = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="color-scheme" content="light" />
    <meta name="supported-color-schemes" content="light" />
    <title>${subject}</title>
    <style>
      :root { color-scheme: light; supported-color-schemes: light; }
      body, .dd-body { background: #F8FAFC !important; }
      .dd-badge { background: ${PRIMARY} !important; color: #ffffff !important; }
      .dd-h1 { color: ${FOREGROUND} !important; }
      .dd-muted { color: ${MUTED} !important; }
      .dd-fg { color: ${FOREGROUND} !important; }
      .dd-hero { background: ${PRIMARY_TINT} !important; border-color: ${PRIMARY_BORDER} !important; }
      .dd-hero-label { color: ${PRIMARY} !important; }
      .dd-tile { background: #ffffff !important; border-color: ${BORDER} !important; }
      .dd-footer { color: #A1A1AA !important; }
      @media (prefers-color-scheme: dark) {
        body, .dd-body { background: #F8FAFC !important; }
        .dd-badge { background: ${PRIMARY} !important; color: #ffffff !important; }
        .dd-h1 { color: ${FOREGROUND} !important; }
        .dd-muted { color: ${MUTED} !important; }
        .dd-fg { color: ${FOREGROUND} !important; }
        .dd-hero { background: ${PRIMARY_TINT} !important; border-color: ${PRIMARY_BORDER} !important; }
        .dd-hero-label { color: ${PRIMARY} !important; }
        .dd-tile { background: #ffffff !important; border-color: ${BORDER} !important; }
        .dd-footer { color: #A1A1AA !important; }
      }
    </style>
  </head>
  <body class="dd-body" style="margin: 0; padding: 0; background: #F8FAFC;">
    <div class="dd-body" style="background: #F8FAFC; padding: 32px 16px; font-family: Arial, Helvetica, sans-serif;">
      <div style="max-width: 480px; margin: 0 auto;">
        <span class="dd-badge" style="display: inline-block; background: ${PRIMARY}; color: #ffffff; font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; padding: 4px 10px; border-radius: 999px;">TAFS</span>
        <h1 class="dd-h1" style="margin: 12px 0 2px; font-size: 20px; color: ${FOREGROUND};">Daily Digest</h1>
        <p class="dd-muted" style="margin: 0 0 20px; font-size: 13px; color: ${MUTED};">${data.dateLabel}</p>

        <div class="dd-hero" style="background: ${PRIMARY_TINT}; border: 1px solid ${PRIMARY_BORDER}; border-radius: 16px; padding: 16px 18px; margin-bottom: 8px;">
          <div class="dd-hero-label" style="font-size: 11px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: ${PRIMARY};">Money deposited today</div>
          <div class="dd-fg" style="font-size: 28px; font-weight: 700; color: ${FOREGROUND}; margin-top: 4px;">${data.depositsTotal}</div>
          <div class="dd-muted" style="font-size: 13px; color: ${MUTED}; margin-top: 2px;">${data.depositsCount} deposit${data.depositsCount === 1 ? '' : 's'}</div>
        </div>

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: separate; margin-top: 4px;">
          <tr>
            ${tile('Employees clocked in', String(data.employeesClockedIn))}
            ${tile('Employees clocked out', String(data.employeesClockedOut))}
          </tr>
          <tr>
            ${tile('Students clocked in', String(data.studentsClockedIn))}
            ${tile('Students clocked out', String(data.studentsClockedOut))}
          </tr>
        </table>

        <p class="dd-footer" style="margin: 20px 0 0; font-size: 11px; color: #A1A1AA; text-align: center;">Automated report — TAFS Admin</p>
      </div>
    </div>
  </body>
</html>`;

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
