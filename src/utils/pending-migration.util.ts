import { Prisma } from '@prisma/client';

/**
 * True when Prisma failed because the table or column is not in the database
 * yet — i.e. a migration has been merged but not deployed.
 *
 * The datasource is the shared remote DB and `prisma migrate deploy` is run
 * deliberately, so code reaches production BEFORE its migration does. See
 * CLAUDE.md rule 11. Reads on boot-critical or login-critical paths must
 * degrade instead of throwing, or the whole app goes down for a feature
 * nobody is using yet.
 *
 *   P2021 — the table does not exist in the current database
 *   P2022 — the column does not exist in the current database
 *   P2010 — raw query failed (Postgres 42P01: relation does not exist, 42703: column does not exist)
 */
export function isPendingMigrationError(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) {
    return false;
  }
  if (err.code === 'P2021' || err.code === 'P2022') {
    return true;
  }
  if (err.code === 'P2010') {
    const dbCode = err.meta?.code;
    const dbMessage = typeof err.meta?.message === 'string' ? err.meta.message : '';
    if (dbCode === '42P01' || dbCode === '42703') {
      return true;
    }
    if (dbMessage.includes('does not exist')) {
      return true;
    }
  }
  return false;
}

/**
 * Runs `read`, falling back to `fallback` when its table/column has not been
 * migrated yet. Any other error propagates untouched — this must never become
 * a blanket catch.
 */
export async function readUntilMigrated<T>(
  read: () => Promise<T>,
  fallback: T,
  onPending?: (err: unknown) => void,
): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (!isPendingMigrationError(err)) throw err;
    onPending?.(err);
    return fallback;
  }
}
