import { ConflictException } from '@nestjs/common';
import { StudentCategoriesService, codeFromLabel } from './student-categories.service';

describe('codeFromLabel (TAFSD-475)', () => {
  it('makes a fixed code from the name', () => {
    expect(codeFromLabel('Staff Child')).toBe('STAFF_CHILD');
    expect(codeFromLabel('Sehm-e-Sadaat')).toBe('SEHM_E_SADAAT');
    expect(codeFromLabel('  Staff child (50%) ')).toBe('STAFF_CHILD_50');
    expect(codeFromLabel('50% Waiver')).toBe('CAT_50_WAIVER');
  });
});

describe('StudentCategoriesService (TAFSD-475)', () => {
  const audit = { log: jest.fn(), logMany: jest.fn() };

  it('adds a category after the last one, with a code from its name', async () => {
    const prisma = {
      student_categories: {
        findFirst: jest.fn().mockResolvedValue(null),
        aggregate: jest.fn().mockResolvedValue({ _max: { display_order: 50 } }),
        create: jest.fn(async ({ data }: any) => ({ id: 6, is_active: true, ...data })),
      },
    };
    const svc = new StudentCategoriesService(prisma as any, audit as any);
    const row = await svc.create({ label: 'Staff Child', tone: 'teal' }, 'admin');
    expect(prisma.student_categories.create).toHaveBeenCalledWith({
      data: { code: 'STAFF_CHILD', label: 'Staff Child', description: null, tone: 'teal', display_order: 60 },
    });
    expect(row).toEqual(expect.objectContaining({ key: 'STAFF_CHILD', order: 60 }));
  });

  it('refuses a second category with the same name', async () => {
    const prisma = {
      student_categories: {
        findFirst: jest.fn().mockResolvedValue({ code: 'COMPLEMENTARY', label: 'Complementary' }),
      },
    };
    const svc = new StudentCategoriesService(prisma as any, audit as any);
    await expect(svc.create({ label: 'complementary', code: 'COMP_2' }, 'admin')).rejects.toThrow(
      'A category called "Complementary" already exists',
    );
  });

  it('refuses to delete a category students hold', async () => {
    const prisma = {
      student_categories: {
        findUnique: jest.fn().mockResolvedValue({
          id: 1,
          label: 'Fee Endowment',
          code: 'FEE_ENDOWMENT',
          _count: { student_category_assignments: 83 },
        }),
        delete: jest.fn(),
      },
    };
    const svc = new StudentCategoriesService(prisma as any, audit as any);
    await expect(svc.remove(1, 'admin')).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.student_categories.delete).not.toHaveBeenCalled();
  });
});
