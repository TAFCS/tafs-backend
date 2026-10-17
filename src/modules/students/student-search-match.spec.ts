import { StaffRole } from '@prisma/client';
import { findStudentSearchHits } from './student-search-match';
import { StudentsService } from './students.service';

// TAFSD-344: student search matches student, guardian and family identifiers.

function capture() {
  const calls: { sql: string; values: unknown[] }[] = [];
  const prisma = {
    $queryRaw: jest.fn(async (q: { sql: string; values: unknown[] }) => {
      calls.push({ sql: q.sql, values: q.values });
      return [{ cc: 7898, hit_rank: 8, why: 'Father phone: X' }];
    }),
  };
  return { prisma, calls };
}

describe('findStudentSearchHits', () => {
  it('a phone in any format searches phones by its core digits', async () => {
    for (const q of ['0300-2920040', '+923002920040', '3002920040']) {
      const { prisma, calls } = capture();
      await findStudentSearchHits(prisma as any, q);
      expect(calls[0].sql).toMatch(/primary_phone/);
      expect(calls[0].values).toContain('%3002920040%');
    }
  });

  it('a CNIC with dashes searches CNICs by digits', async () => {
    const { prisma, calls } = capture();
    await findStudentSearchHits(prisma as any, '42201-0336664-5');
    expect(calls[0].sql).toMatch(/g\.cnic/);
    expect(calls[0].values).toContain('%4220103366645%');
  });

  it('a name searches student, guardian and family names, not phones', async () => {
    const { prisma, calls } = capture();
    await findStudentSearchHits(prisma as any, 'Atif');
    expect(calls[0].sql).toMatch(/g\.full_name ILIKE/);
    expect(calls[0].sql).toMatch(/household_name ILIKE/);
    expect(calls[0].sql).not.toMatch(/primary_phone/);
  });

  it('a short number only checks CC, GR and family number', async () => {
    const { prisma, calls } = capture();
    await findStudentSearchHits(prisma as any, '12');
    expect(calls[0].sql).not.toMatch(/primary_phone|cnic/);
    expect(calls[0].sql).toMatch(/s\.cc = /);
  });

  it('empty text never queries', async () => {
    const { prisma } = capture();
    expect(await findStudentSearchHits(prisma as any, '  ')).toEqual([]);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('StudentsService.searchSimple', () => {
  it('keeps the match reason and drops hits outside the caller\'s scope', async () => {
    const service = Object.create(StudentsService.prototype) as any;
    service.prisma = {
      students: {
        findFirst: jest.fn(async () => null),
        findMany: jest.fn(async (args: any) => {
          // Scope lets through 7898 only.
          expect(args.where.cc.in).toEqual([7898, 6201]);
          return [{ cc: 7898, full_name: 'A', gr_number: '1' }];
        }),
      },
      $queryRaw: jest.fn(async () => [
        { cc: 7898, hit_rank: 8, why: 'Father phone: X' },
        { cc: 6201, hit_rank: 9, why: 'Family: Y' },
      ]),
    };
    service.scope = { isExempt: () => true, scopeOf: () => ({ campuses: [], classes: [], sections: [], segments: [] }) };
    const rows = await service.searchSimple({ q: '0300-2920040' }, { role: StaffRole.SUPER_ADMIN } as any);
    expect(rows).toEqual([{ cc: 7898, full_name: 'A', gr_number: '1', matched_on: 'Father phone: X' }]);
  });
});
