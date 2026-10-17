/**
 * Send the admin daily digest for a past day to a given address (TAFSD-371).
 * Needs the Brevo SMTP env, so run it through Railway:
 *
 *   railway run npx ts-node -T scripts/send-digest-sample.ts 2026-10-16 someone@example.com
 */
import { PrismaClient } from '@prisma/client';
import { MailerService } from '../src/common/mailer/mailer.service';
import { DailyDigestService } from '../src/modules/daily-digest/daily-digest.service';

async function main() {
    const [dayKey, ...to] = process.argv.slice(2);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey ?? '') || to.length === 0) {
        throw new Error('Usage: send-digest-sample.ts YYYY-MM-DD email [email...]');
    }
    const prisma = new PrismaClient();
    const mailer = new MailerService();
    mailer.onModuleInit();
    try {
        await new DailyDigestService(prisma as any, mailer).sendDigest({ dayKey, to });
    } finally {
        await prisma.$disconnect();
    }
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
