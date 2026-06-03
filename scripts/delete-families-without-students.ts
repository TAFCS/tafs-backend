/**
 * Soft-delete families that have no active students.
 *
 * Usage:
 *   npx ts-node scripts/delete-families-without-students.ts           # preview only
 *   npx ts-node scripts/delete-families-without-students.ts --execute # apply
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const execute = process.argv.includes('--execute');

async function main() {
  const targets = await prisma.families.findMany({
    where: {
      deleted_at: null,
      students: { none: { deleted_at: null } },
    },
    select: {
      id: true,
      household_name: true,
      email: true,
      legacy_pid: true,
      created_at: true,
      _count: {
        select: {
          student_siblings: true,
          family_refresh_tokens: true,
          fcm_device_tokens: true,
          parent_change_requests: true,
          notice_post_reads: true,
          message_acknowledgments: true,
        },
      },
    },
    orderBy: { id: 'asc' },
  });

  console.log(`Found ${targets.length} active famil(ies) with no active students.\n`);

  if (targets.length === 0) {
    return;
  }

  for (const f of targets) {
    console.log(
      `  #${f.id} ${f.household_name}` +
        (f.email ? ` <${f.email}>` : '') +
        ` | siblings=${f._count.student_siblings}` +
        ` tokens=${f._count.family_refresh_tokens}` +
        ` fcm=${f._count.fcm_device_tokens}` +
        ` change_req=${f._count.parent_change_requests}` +
        ` notice_reads=${f._count.notice_post_reads}` +
        ` msg_acks=${f._count.message_acknowledgments}`,
    );
  }

  if (!execute) {
    console.log('\nDry run only. Re-run with --execute to soft-delete these families.');
    return;
  }

  const now = new Date();
  const ids = targets.map((f) => f.id);

  const result = await prisma.$transaction(async (tx) => {
    await tx.family_refresh_tokens.updateMany({
      where: { family_id: { in: ids }, revoked_at: null },
      data: { revoked_at: now },
    });

    await tx.fcm_device_tokens.deleteMany({
      where: { family_id: { in: ids } },
    });

    await tx.message_acknowledgments.deleteMany({
      where: { family_id: { in: ids } },
    });

    await tx.notice_post_reads.deleteMany({
      where: { family_id: { in: ids } },
    });

    await tx.parent_change_requests.deleteMany({
      where: { family_id: { in: ids } },
    });

    await tx.student_siblings.deleteMany({
      where: { family_id: { in: ids } },
    });

    await tx.chat_conversations.updateMany({
      where: { family_id: { in: ids } },
      data: {
        family_id: null,
        unread_by_parent: 0,
        last_message_snippet: null,
      },
    });

    const updated = await tx.families.updateMany({
      where: { id: { in: ids }, deleted_at: null },
      data: {
        deleted_at: now,
        password_hash: null,
        email: null,
      },
    });

    return updated.count;
  });

  console.log(`\nSoft-deleted ${result} famil(ies).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
