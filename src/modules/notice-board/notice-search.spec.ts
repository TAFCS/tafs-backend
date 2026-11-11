import { NoticeBoardService } from './notice-board.service';

// TAFSD-497: the admin board search finds a notice by its wording, its poster,
// or any student, family or class it was sent to.

function build(found: { classes?: { id: number }[]; students?: { cc: number }[] } = {}) {
  const prisma = {
    classes: { findMany: jest.fn(async () => found.classes ?? []) },
    students: { findMany: jest.fn(async () => found.students ?? []) },
  };
  const service = new NoticeBoardService(prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  return { prisma, search: (q?: string) => (service as any)._searchWhere(q) };
}

describe('notice board search', () => {
  it('is off for an empty search', async () => {
    const { prisma, search } = build();
    expect(await search(undefined)).toBeNull();
    expect(await search('   ')).toBeNull();
    expect(prisma.students.findMany).not.toHaveBeenCalled();
  });

  it('matches wording and poster, and posts sent to the matching students', async () => {
    const { search } = build({ students: [{ cc: 7733 }] });
    const where = await search(' 7733 ');
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { title: { contains: '7733', mode: 'insensitive' } },
        { body: { contains: '7733', mode: 'insensitive' } },
        { users: { full_name: { contains: '7733', mode: 'insensitive' } } },
        { student_ccs: { hasSome: [7733] } },
      ]),
    );
  });

  it('looks a number up as a C.C., family number or GR', async () => {
    const { prisma, search } = build();
    await search('6327');
    const or = (prisma.students.findMany.mock.calls[0] as any)[0].where.OR;
    expect(or).toEqual(
      expect.arrayContaining([{ cc: 6327 }, { family_id: 6327 }, { gr_number: { equals: '6327', mode: 'insensitive' } }]),
    );
  });

  it('looks names up only from three letters, so a short word doesn\'t pull in every student', async () => {
    const { prisma, search } = build();
    await search('ab');
    const or = (prisma.students.findMany.mock.calls[0] as any)[0].where.OR;
    expect(JSON.stringify(or)).not.toContain('full_name');
    await search('Amnah');
    const or2 = (prisma.students.findMany.mock.calls[1] as any)[0].where.OR;
    expect(or2).toEqual(expect.arrayContaining([{ full_name: { contains: 'Amnah', mode: 'insensitive' } }]));
  });

  it('finds class notices, and notices to students now in that class', async () => {
    const { prisma, search } = build({ classes: [{ id: 18 }], students: [{ cc: 44 }] });
    const where = await search('IX');
    expect(where.OR).toEqual(
      expect.arrayContaining([{ class_ids: { hasSome: [18] } }, { student_ccs: { hasSome: [44] } }]),
    );
    const or = (prisma.students.findMany.mock.calls[0] as any)[0].where.OR;
    expect(or).toEqual(expect.arrayContaining([{ class_id: { in: [18] }, deleted_at: null }]));
  });
});
