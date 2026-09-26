import { BadRequestException } from '@nestjs/common';
import { AccessService } from './access.service';

// Segments are academic — only teaching staff carry one. A scope may list
// segments only alongside a segment-bearing department (or Departments = All).
describe('Scope: segments require a segment-bearing department', () => {
  const ACADEMICS = 1;
  const SUPPORT = 6;

  const mk = () => {
    const prisma = {
      employee_profiles: {
        // Only Academics staff have a segment set.
        findMany: jest.fn().mockResolvedValue([{ department_id: ACADEMICS }]),
      },
    };
    const svc = new AccessService(prisma as any, {} as any, {} as any);
    const check = (scope: Record<string, number[]>) =>
      (svc as any).assertSegmentsFitDepartments(scope) as Promise<void>;
    return { check, prisma };
  };

  it('refuses segments when Departments exclude the teaching department', async () => {
    const { check } = mk();
    await expect(check({ segments: [3], departments: [SUPPORT] })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('allows segments alongside the teaching department', async () => {
    const { check } = mk();
    await expect(check({ segments: [3], departments: [SUPPORT, ACADEMICS] })).resolves.toBeUndefined();
  });

  it('allows segments when Departments is All, and anything when Segments is All', async () => {
    const { check, prisma } = mk();
    await expect(check({ segments: [3], departments: [] })).resolves.toBeUndefined();
    await expect(check({ segments: [], departments: [SUPPORT] })).resolves.toBeUndefined();
    // Neither case needs the lookup.
    expect(prisma.employee_profiles.findMany).not.toHaveBeenCalled();
  });
});
