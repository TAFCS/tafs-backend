/**
 * One-off migration: renames every "name@tafs.com" style portal username to
 * the new "name1.name2.name3" format derived from the user's full name.
 *
 * Dry run (default) — prints the planned renames without writing anything:
 *   npx ts-node scripts/rename-tafs-usernames.ts
 *
 * Apply for real:
 *   npx ts-node scripts/rename-tafs-usernames.ts --apply
 */
import { PrismaClient } from '@prisma/client';
import { generateUniqueUsername } from '../src/common/utils/account-credentials.util';

const prisma = new PrismaClient();

async function main() {
  const apply = process.argv.includes('--apply');

  const allUsers = await prisma.users.findMany({
    select: { id: true, username: true, full_name: true },
    orderBy: { created_at: 'asc' },
  });

  const existingUsernames = new Set(allUsers.map((u) => u.username.toLowerCase()));
  const legacyUsers = allUsers.filter((u) => /@tafs\.com$/i.test(u.username));

  if (legacyUsers.length === 0) {
    console.log('No "@tafs.com" style usernames found — nothing to do.');
    return;
  }

  console.log(`Found ${legacyUsers.length} legacy "@tafs.com" username(s).`);
  console.log(apply ? 'Running in APPLY mode — changes will be written.\n' : 'Running in DRY-RUN mode — pass --apply to write changes.\n');

  const renames: { id: string; from: string; to: string }[] = [];

  for (const user of legacyUsers) {
    // Free up the old slot before generating so the new name can't collide with itself.
    existingUsernames.delete(user.username.toLowerCase());
    const next = generateUniqueUsername(user.full_name || user.username, existingUsernames);
    existingUsernames.add(next.toLowerCase());
    renames.push({ id: user.id, from: user.username, to: next });
  }

  for (const r of renames) {
    console.log(`  ${r.from}  ->  ${r.to}`);
  }

  if (!apply) {
    console.log('\nDry run complete. Re-run with --apply to commit these renames.');
    return;
  }

  for (const r of renames) {
    await prisma.users.update({ where: { id: r.id }, data: { username: r.to } });
  }
  console.log(`\nRenamed ${renames.length} username(s).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
