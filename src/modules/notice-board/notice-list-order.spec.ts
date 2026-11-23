import { NoticeBoardService } from './notice-board.service';

// TAFSD-580: the admin board runs newest first across pages. Holiday notices are
// dated by the holiday and paged with the posts, and posts page by posted_at
// (approval re-dates a post), so "Load older posts" never appends anything newer
// than what is already on screen.

const NOV = (day: number, hour = 12) => new Date(Date.UTC(2026, 10, day, hour));
const DAY = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

type Row = { id: number; is_pinned: boolean; posted_at: Date; [k: string]: unknown };

const post = (id: number, posted_at: Date, over: Partial<Row> = {}): Row => ({
  id,
  posted_by: 'other',
  title: `Post ${id}`,
  body: '',
  campus_ids: [],
  class_ids: [],
  section_ids: [],
  student_ccs: [],
  is_pinned: false,
  posted_at,
  status: 'APPROVED',
  ...over,
});

const holiday = (id: number, date: Date, description: string | null = 'Holiday') => ({
  id,
  campus_id: 1,
  class_id: null,
  section_id: null,
  date,
  day_type: 'HOLIDAY',
  applies_to: 'STUDENT',
  description,
  created_by: null,
});

// 40 posts, one a day back from 22 Nov at noon: ids 100..139, newest id newest.
// Post 50 was written long ago and approved on 23 Nov, so it is the newest by
// posted_at while having the smallest id.
const POSTS: Row[] = [
  ...Array.from({ length: 40 }, (_, i) => post(139 - i, new Date(NOV(22).getTime() - i * 86_400_000))),
  post(50, NOV(23)),
  post(7, DAY(2025, 1, 1), { is_pinned: true }),
];

const HOLIDAYS = [
  holiday(1, DAY(2026, 12, 25)), // future closure
  holiday(2, DAY(2026, 11, 10)), // inside page 1's span
  holiday(3, DAY(2026, 10, 18)), // older than page 1, inside page 2
  holiday(4, DAY(2026, 8, 14)), // older than every post
  holiday(5, DAY(2026, 8, 26), '[PINNED] Eid'), // pinned: first page, whatever its date
];

const cmp = (a: Row, b: Row) => b.posted_at.getTime() - a.posted_at.getTime() || b.id - a.id;

function matches(row: any, w: any): boolean {
  if (!w) return true;
  for (const [k, v] of Object.entries<any>(w)) {
    if (k === 'AND') { if (!v.every((x: any) => matches(row, x))) return false; continue; }
    if (k === 'OR') { if (!v.some((x: any) => matches(row, x))) return false; continue; }
    if (k === 'NOT') { if (matches(row, v)) return false; continue; }
    const val = row[k];
    if (v === null) { if (val != null) return false; continue; }
    if (v instanceof Date) { if (val?.getTime() !== v.getTime()) return false; continue; }
    if (typeof v !== 'object') { if (val !== v) return false; continue; }
    const t = (x: any) => (x instanceof Date ? x.getTime() : x);
    if ('lt' in v && !(t(val) < t(v.lt))) return false;
    if ('lte' in v && !(t(val) <= t(v.lte))) return false;
    if ('gte' in v && !(t(val) >= t(v.gte))) return false;
    if ('in' in v && !v.in.includes(val)) return false;
    if ('startsWith' in v && !(typeof val === 'string' && val.startsWith(v.startsWith))) return false;
  }
  return true;
}

function build() {
  const prisma = {
    notice_board_posts: {
      findMany: jest.fn(async ({ where, skip = 0, take }: any) => {
        const { deleted_at, ...rest } = where;
        const rows = POSTS.filter((p) => matches(p, rest)).sort(cmp);
        return rows.slice(skip, take ? skip + take : undefined);
      }),
      findUnique: jest.fn(async ({ where }: any) => POSTS.find((p) => p.id === where.id) ?? null),
    },
    academic_calendar_days: {
      findMany: jest.fn(async ({ where, take }: any) =>
        HOLIDAYS.filter((h) => matches(h, where))
          .sort((a, b) => b.date.getTime() - a.date.getTime())
          .slice(0, take),
      ),
    },
    users: { findMany: jest.fn(async () => []) },
  };
  const scope = { isExempt: () => true };
  const service = new NoticeBoardService(prisma as any, {} as any, {} as any, {} as any, {} as any, scope as any, {} as any);
  (service as any)._withTargetsAndReach = async (rows: any[]) => rows.map((r) => ({ ...r, targeted_students: [] }));
  (service as any)._holidayReadCounts = async () => new Map();
  (service as any)._countAudienceFamilies = async () => 0;
  const list = async (cursor?: number) => (await service.getAllPosts(cursor, { sub: 'me' } as any)) as any[];
  // What the webapp sends as the next cursor: the last unpinned real post of the page.
  const nextCursor = (page: any[]) =>
    [...page].reverse().find((p) => typeof p.id === 'number' && !p.is_pinned)?.id as number | undefined;
  return { prisma, list, nextCursor };
}

describe('notice board order across pages (TAFSD-580)', () => {
  it('appending each page keeps the board newest first, holidays included', async () => {
    const { list, nextCursor } = build();
    // As the webapp does: append what isn't on screen yet, until a page brings no posts.
    const shown: any[] = [];
    for (let cursor: number | undefined, i = 0; i < 5; i++) {
      const page = await list(cursor);
      const seen = new Set(shown.map((p) => p.id));
      shown.push(...page.filter((p) => !seen.has(p.id)));
      cursor = nextCursor(page);
      if (cursor === undefined) break;
    }

    const unpinned = shown.filter((p) => !p.is_pinned);
    const times = unpinned.map((p) => new Date(p.posted_at).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));

    // Everything turns up exactly once.
    const ids = shown.map((p) => String(p.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual([...POSTS.map((p) => String(p.id)), ...HOLIDAYS.map((h) => `holiday-${h.id}`)].sort());
  });

  it('page 1 holds the pinned items, the newest posts and only the holidays in their span', async () => {
    const { list } = build();
    const ids = (await list()).map((p) => p.id);
    expect(ids.slice(0, 2).sort()).toEqual([7, 'holiday-5'].sort()); // pinned first
    expect(ids).toContain(50); // approved late, so newest
    expect(ids).toContain('holiday-1');
    expect(ids).toContain('holiday-2');
    expect(ids).not.toContain('holiday-3');
    expect(ids).not.toContain('holiday-4');
  });

  it('a later page starts after the cursor post by posted_at, then id', async () => {
    const { prisma, list } = build();
    await list(111);
    const where = (prisma.notice_board_posts.findMany.mock.calls[0] as any)[0].where;
    expect(where.AND).toEqual([
      { OR: [{ posted_at: { lt: POSTS.find((p) => p.id === 111)!.posted_at } }, { posted_at: POSTS.find((p) => p.id === 111)!.posted_at, id: { lt: 111 } }] },
    ]);
  });

  it('an unknown cursor is refused', async () => {
    await expect(build().list(999)).rejects.toThrow('Unknown cursor');
  });
});
