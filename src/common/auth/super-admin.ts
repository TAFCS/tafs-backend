import { ForbiddenException } from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import type { IJwtStaffPayload } from '../../modules/auth/interfaces/jwt-payload.interface';

export function isSuperAdmin(actor?: Pick<IJwtStaffPayload, 'role'> | null): boolean {
  return actor?.role === StaffRole.SUPER_ADMIN;
}

/**
 * Whatever sub-permissions a SUPER_ADMIN hands someone, they let that person
 * change OTHER people's records within the grant -- never
 *   - a record belonging to their own login (their own pay, status, leave,
 *     attendance...), and
 *   - a record belonging to a SUPER_ADMIN login (deactivating or editing the
 *     very accounts that hold the keys).
 * A SUPER_ADMIN passes everything, their own records included.
 *
 * `target.userId` is the login the record belongs to (null when the record
 * has no login, which never blocks); `target.userRole` is that login's role.
 */
export function assertMayChangeRecordOf(
  actor: Pick<IJwtStaffPayload, 'role' | 'sub'> | null | undefined,
  target: { userId: string | null | undefined; userRole?: StaffRole | null },
  what: string,
): void {
  if (isSuperAdmin(actor)) return;
  if (!target.userId) return;
  if (actor && target.userId === actor.sub) {
    throw new ForbiddenException(`You cannot change your own ${what}. Ask a super admin.`);
  }
  if (target.userRole === StaffRole.SUPER_ADMIN) {
    throw new ForbiddenException(`Only a super admin can change a super admin's ${what}.`);
  }
}

type EmployeeLinkReader = {
  employee_profiles: {
    findUnique(args: {
      where: { id: number };
      select: { user_id: true; users: { select: { role: true } } };
    }): Promise<{ user_id: string | null; users: { role: StaffRole } | null } | null>;
  };
};

/**
 * assertMayChangeRecordOf for a record that belongs to an employee: looks up
 * the employee's login and checks it. No query for a SUPER_ADMIN.
 */
export async function assertMayChangeEmployee(
  prisma: EmployeeLinkReader,
  actor: Pick<IJwtStaffPayload, 'role' | 'sub'> | null | undefined,
  employeeId: number,
  what: string,
): Promise<void> {
  if (isSuperAdmin(actor)) return;
  const row = await prisma.employee_profiles.findUnique({
    where: { id: employeeId },
    select: { user_id: true, users: { select: { role: true } } },
  });
  assertMayChangeRecordOf(actor, { userId: row?.user_id, userRole: row?.users?.role }, what);
}
