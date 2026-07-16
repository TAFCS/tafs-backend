import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

type TxClient = Prisma.TransactionClient;

/** Shared Computer Code allocator — single number space for all student creates. */
@Injectable()
export class CcAllocatorService {
  /** Advisory lock key dedicated to CC allocation. */
  private static readonly LOCK_KEY = 872314001;

  async next(tx: TxClient): Promise<number> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CcAllocatorService.LOCK_KEY})`;

    const maxStudent = await tx.students.aggregate({ _max: { cc: true } });
    // While collision leftovers remain in unconfirmed_admissions, avoid reusing those IDs.
    const maxUnconfirmed = await tx.unconfirmed_admissions.aggregate({
      _max: { id: true },
    });

    return Math.max(maxStudent._max.cc || 0, maxUnconfirmed._max.id || 0) + 1;
  }
}
