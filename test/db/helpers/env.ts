import { assertThrowawayDatabase } from './assert-throwaway-db';

// Runs in every test worker before the spec file is imported.
const url = assertThrowawayDatabase();

// Prisma's datasource also reads DIRECT_URL; pin it to the same throwaway DB.
process.env.DIRECT_URL = url;
process.env.NODE_ENV = 'test';
// Cron jobs (voucher expiry, digests, backups...) must not fire mid-test.
process.env.SCHEDULERS_ENABLED = 'false';
// Tokens are minted by the specs themselves; any value works as long as both
// sides agree. Never a real secret.
process.env.JWT_SECRET = 'db-suite-jwt-secret';
process.env.JWT_REFRESH_SECRET = 'db-suite-jwt-refresh-secret';
// Nothing in the suite may reach external services. These are set to an
// empty string, not deleted: ConfigModule.forRoot() loads a local `.env` when
// one exists and fills in every key that is *missing* from process.env, so a
// deleted key would come straight back from a developer's (production) .env —
// real DO Spaces uploads, push notifications, email, bank APIs. A key that is
// present, even empty, is left alone, and every service treats '' as unset
// (storage falls back to mock URLs, FCM/email stay off).
const EXTERNAL_SERVICE_KEYS = [
    'REDIS_URL',
    'DO_SPACES_REGION', 'DO_SPACES_ENDPOINT', 'DO_SPACES_KEY', 'DO_SPACES_SECRET', 'DO_SPACES_BUCKET', 'DO_SPACES_CDN_ENDPOINT',
    'FIREBASE_SERVICE_ACCOUNT_JSON',
    'RESEND_API_KEY', 'RESEND_FROM_EMAIL', 'RESEND_FROM_NAME',
    'BREVO_SMTP_HOST', 'BREVO_SMTP_PORT', 'BREVO_SMTP_USER', 'BREVO_SMTP_KEY', 'BREVO_FROM_EMAIL', 'BREVO_FROM_NAME',
    'DAILY_DIGEST_RECIPIENTS',
    'CORAL9_DATABASE_URL', 'CORAL9_FLUSH_SECRET', 'CORAL9_CRON_SECRET',
    'MEEZAN_SERVICE_USER_ID', 'MEEZAN_SERVICE_PASSWORD', 'MEEZAN_COMPANY_CODE',
    'UBL_SERVICE_USER_ID', 'UBL_SERVICE_PASSWORD',
];
for (const key of EXTERNAL_SERVICE_KEYS) process.env[key] = '';
