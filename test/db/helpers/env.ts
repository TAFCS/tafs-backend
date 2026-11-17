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
// Nothing in the suite may reach external services.
delete process.env.REDIS_URL;
delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
delete process.env.RESEND_API_KEY;
