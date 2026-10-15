import { StaffRole } from '@prisma/client';
import { NoticeBoardService } from './notice-board.service';

// TAFSD-315: the admin board shows a scoped caller every post that reached one
// of their students, not only posts aimed wholly inside their scope.

const scoped = { sub: 'rk', role: StaffRole.EMPLOYEE } as any;
// Rehmat-style scope: GEJ (1), Middle & Secondary segment — classes 15-19.
const IN_SCOPE = [
  { cc: 44, campus_id: 1, class_id: 16, section_id: 1 },
  { cc: 45, campus_id: 1, class_id: 18, section_id: 2 },
];

function build(opts: { exempt?: boolean; unrestricted?: boolean } = {}) {
  const prisma = { students: { findMany: jest.fn(async () => IN_SCOPE) } };
  const scope = {
    isExempt: () => !!opts.exempt,
    whereForStudents: () => (opts.unrestricted ? {} : { campus_id: { in: [1] }, classes: { segment_id: { in: [6] } } }),
  };
  const service = new NoticeBoardService(prisma as any, {} as any, {} as any, {} as any, {} as any, scope as any);
  return { prisma, reach: () => (service as any)._scopeReach(scoped) };
}

const post = (over: Record<string, unknown> = {}) => ({
  posted_by: 'someone',
  campus_ids: [],
  class_ids: [],
  section_ids: [],
  student_ccs: [],
  ...over,
});

describe('notice board reach visibility', () => {
  it('shows posts that reached any of the caller\'s students', async () => {
    const r = await build().reach();
    expect(r.reaches(post())).toBe(true); // school-wide
    expect(r.reaches(post({ campus_ids: [1] }))).toBe(true); // all of GEJ
    expect(r.reaches(post({ campus_ids: [1, 2, 3] }))).toBe(true);
    expect(r.reaches(post({ campus_ids: [1], class_ids: [16] }))).toBe(true);
    expect(r.reaches(post({ class_ids: [18], section_ids: [2] }))).toBe(true);
  });

  it('hides posts none of whose students are in scope', async () => {
    const r = await build().reach();
    expect(r.reaches(post({ campus_ids: [2] }))).toBe(false); // KNF
    expect(r.reaches(post({ campus_ids: [1], class_ids: [1, 2, 3] }))).toBe(false); // pre-primary
    expect(r.reaches(post({ class_ids: [16], section_ids: [2] }))).toBe(false); // no VII-2 student in scope
  });

  it('matches student-targeted posts by CC only', async () => {
    const r = await build().reach();
    expect(r.reaches(post({ campus_ids: [2], student_ccs: [44, 9001] }))).toBe(true);
    expect(r.reaches(post({ campus_ids: [1], student_ccs: [9001] }))).toBe(false);
    expect(r.seesStudent(44)).toBe(true);
    expect(r.seesStudent(9001)).toBe(false);
  });

  it('always shows own posts', async () => {
    const r = await build().reach();
    expect(r.reaches(post({ posted_by: 'rk', campus_ids: [2] }))).toBe(true);
  });

  it('superadmins and unscoped staff see everything, with no student lookup', async () => {
    for (const opts of [{ exempt: true }, { unrestricted: true }]) {
      const { prisma, reach } = build(opts);
      await expect(reach()).resolves.toBeNull();
      expect(prisma.students.findMany).not.toHaveBeenCalled();
    }
  });
});
