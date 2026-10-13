import { BadRequestException } from '@nestjs/common';
import { AccessService } from './access.service';

// Staff categories belong to a department. A scope may list categories only
// from its selected departments (or with Departments = All).
describe('Scope: staff categories must sit inside the selected departments', () => {
  const ACADEMICS = 6;
  const ADMINISTRATION = 10;
  const TEACHER = 1; // Academics
  const IT_STAFF = 9; // Administration

  const mk = () => {
    const categories = [
      { id: TEACHER, name: 'TEACHER', department_id: ACADEMICS },
      { id: IT_STAFF, name: 'IT STAFF', department_id: ADMINISTRATION },
    ];
    const prisma = {
      staff_categories: {
        findMany: jest.fn(async ({ where }: { where: { id: { in: number[] } } }) =>
          categories.filter((c) => where.id.in.includes(c.id)),
        ),
      },
    };
    const svc = new AccessService(prisma as any, {} as any, {} as any);
    const check = (scope: Record<string, number[]>) =>
      (svc as any).assertStaffCategoriesFitDepartments(scope) as Promise<void>;
    return { check, prisma };
  };

  it('refuses a category whose department is not selected', async () => {
    const { check } = mk();
    await expect(check({ staffCategories: [IT_STAFF], departments: [ACADEMICS] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      check({ staffCategories: [TEACHER, IT_STAFF], departments: [ACADEMICS] }),
    ).rejects.toThrow(/IT STAFF/);
  });

  it('allows categories inside the selected departments', async () => {
    const { check } = mk();
    await expect(check({ staffCategories: [TEACHER], departments: [ACADEMICS] })).resolves.toBeUndefined();
    await expect(
      check({ staffCategories: [TEACHER, IT_STAFF], departments: [ACADEMICS, ADMINISTRATION] }),
    ).resolves.toBeUndefined();
  });

  it('allows any category when Departments is All, and anything when Categories is All', async () => {
    const { check, prisma } = mk();
    await expect(check({ staffCategories: [IT_STAFF], departments: [] })).resolves.toBeUndefined();
    await expect(check({ staffCategories: [], departments: [ACADEMICS] })).resolves.toBeUndefined();
    // Neither case needs the lookup.
    expect(prisma.staff_categories.findMany).not.toHaveBeenCalled();
  });
});
