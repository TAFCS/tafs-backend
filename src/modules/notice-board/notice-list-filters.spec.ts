import { NoticeBoardService } from './notice-board.service';

// TAFSD-507: "My sent" and the campus / class / section filters on the admin board.

// Students: 1 in campus 1 / class 18 / section 5; 2 in campus 2 / class 18 / section 9.
const STUDENTS = [
  { cc: 1, campus_id: 1, class_id: 18, section_id: 5 },
  { cc: 2, campus_id: 2, class_id: 18, section_id: 9 },
];

const post = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  posted_by: 'other',
  title: `Post ${id}`,
  body: '',
  campus_ids: [],
  class_ids: [],
  section_ids: [],
  student_ccs: [],
  is_pinned: false,
  posted_at: new Date(2026, 10, id),
  status: 'APPROVED',
  ...over,
});

const POSTS = [
  post(1), // school-wide
  post(2, { campus_ids: [1] }),
  post(3, { campus_ids: [2] }),
  post(4, { campus_ids: [1], class_ids: [19] }), // a class nobody in campus 1 is in
  post(5, { student_ccs: [2] }),
  post(6, { posted_by: 'me', campus_ids: [2] }),
];

function build() {
  const prisma = {
    students: {
      findMany: jest.fn(async ({ where }: any) =>
        STUDENTS.filter(
          (s) =>
            (!where.campus_id || where.campus_id.in.includes(s.campus_id)) &&
            (!where.class_id || where.class_id.in.includes(s.class_id)) &&
            (!where.section_id || where.section_id.in.includes(s.section_id)),
        ),
      ),
    },
    notice_board_posts: {
      findMany: jest.fn(async ({ where }: any) => {
        if (where.is_pinned) return [];
        const mine = (where.AND ?? []).some((w: any) => w.posted_by === 'me');
        return POSTS.filter((p) => !mine || p.posted_by === 'me');
      }),
    },
    academic_calendar_days: { findMany: jest.fn(async () => []) },
    users: { findMany: jest.fn(async () => []) },
  };
  const scope = { isExempt: () => true };
  const service = new NoticeBoardService(prisma as any, {} as any, {} as any, {} as any, {} as any, scope as any, {} as any);
  (service as any)._withTargetsAndReach = async (rows: any[]) => rows.map((r) => ({ ...r, targeted_students: [] }));
  (service as any)._holidayReadCounts = async () => new Map();
  const list = async (filters: any) =>
    ((await service.getAllPosts(undefined, { sub: 'me' } as any, undefined, filters)) as any[]).map((p) => p.id).sort();
  return { prisma, list };
}

describe('notice board list filters (TAFSD-507)', () => {
  it('shows everything without filters', async () => {
    expect(await build().list({})).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('My sent asks the database for the caller\'s own posts only', async () => {
    const { prisma, list } = build();
    expect(await list({ mine: true })).toEqual([6]);
    const where = (prisma.notice_board_posts.findMany.mock.calls[0] as any)[0].where;
    expect(where.AND).toEqual([{ posted_by: 'me' }]);
  });

  it('a campus keeps posts that reached a student there: direct, school-wide or to a named student', async () => {
    const { list } = build();
    expect(await list({ campusIds: [1] })).toEqual([1, 2]);
    expect(await list({ campusIds: [2] })).toEqual([1, 3, 5, 6]);
  });

  it('a class or section narrows by where the students are now', async () => {
    const { list } = build();
    expect(await list({ classIds: [18], sectionIds: [5] })).toEqual([1, 2]);
    expect(await list({ classIds: [19] })).toEqual([]);
  });

  it('being the poster does not make a post match a placement filter', async () => {
    const { list } = build();
    expect(await list({ campusIds: [1], mine: true })).toEqual([]);
  });
});
