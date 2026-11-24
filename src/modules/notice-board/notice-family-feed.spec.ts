import { NoticeBoardService } from './notice-board.service';

// TAFSD-594: a notice sent to one section must reach only that section's
// families in the parent feed. The feed used to pool all of a family's
// children, so a child in O-I B plus a sibling in any class's section A made
// the family see O-I A's homework.

const O1 = 12;
const JR3 = 4;
const A = 1;
const B = 2;

const post = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  title: `Post ${id}`,
  deleted_at: null,
  status: 'APPROVED',
  notification_only: false,
  expires_at: null,
  is_pinned: false,
  campus_ids: [] as number[],
  class_ids: [] as number[],
  section_ids: [] as number[],
  student_ccs: [] as number[],
  student_statuses: [] as string[],
  academic_years: [] as string[],
  ...over,
});

const POSTS = [
  post(1, { campus_ids: [1], class_ids: [O1], section_ids: [A], student_statuses: ['ENROLLED'], academic_years: ['2026-2027'] }), // O-I A homework
  post(2, { campus_ids: [1], class_ids: [O1], section_ids: [B], student_statuses: ['ENROLLED'], academic_years: ['2026-2027'] }), // O-I B homework
  post(3, { campus_ids: [1], class_ids: [O1] }), // all of O-I
  post(4), // school-wide
  post(5, { student_ccs: [900] }), // one named student elsewhere
  post(6, { class_ids: [JR3], section_ids: [A] }), // JR-III A
  post(7, { class_ids: [O1], section_ids: [A], student_statuses: ['LEFT'] }), // O-I A, students who left
];

// Matches a Prisma where clause against a plain row (the operators this query uses).
function matches(row: any, w: any): boolean {
  if (!w) return true;
  return Object.entries<any>(w).every(([k, v]) => {
    if (k === 'AND') return (Array.isArray(v) ? v : [v]).every((x) => matches(row, x));
    if (k === 'OR') return v.some((x: any) => matches(row, x));
    if (k === 'NOT') return !matches(row, v);
    const val = row[k];
    if (v === null || typeof v !== 'object' || v instanceof Date) return val === v;
    if ('isEmpty' in v) return (val.length === 0) === v.isEmpty;
    if ('has' in v) return val.includes(v.has);
    if ('hasSome' in v) return v.hasSome.some((x: any) => val.includes(x));
    if ('gt' in v) return val != null && val > v.gt;
    if ('lt' in v) return val < v.lt;
    throw new Error(`unhandled filter ${k}: ${JSON.stringify(v)}`);
  });
}

function feedFor(children: Record<string, unknown>[]) {
  const prisma = {
    students: { findMany: jest.fn(async () => children) },
    notice_board_posts: {
      findMany: jest.fn(async ({ where }: any) => POSTS.filter((p) => matches(p, where))),
    },
  };
  const service = new NoticeBoardService(prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  return service.getPostsForFamily(77).then((rows: any[]) => rows.map((r) => r.id).sort((a, b) => a - b));
}

const child = (cc: number, class_id: number | null, section_id: number | null, over: Record<string, unknown> = {}) => ({
  cc,
  campus_id: 1,
  class_id,
  section_id,
  status: 'ENROLLED',
  academic_year: '2026-2027',
  ...over,
});

describe('parent feed audience (TAFSD-594)', () => {
  it('an O-I B family with a sibling in JR-III A sees O-I B homework, not O-I A', async () => {
    const ids = await feedFor([child(10, O1, B), child(11, JR3, A)]);
    expect(ids).toEqual([2, 3, 4, 6]);
  });

  it('an O-I A family sees O-I A homework, not O-I B', async () => {
    expect(await feedFor([child(20, O1, A)])).toEqual([1, 3, 4]);
  });

  it('a status or year limit applies to the same child as the class and section', async () => {
    // The O-I A child has left; an enrolled sibling elsewhere doesn't carry them in.
    const ids = await feedFor([child(30, O1, A, { status: 'LEFT' }), child(31, JR3, B)]);
    expect(ids).toEqual([3, 4, 7]);
  });

  it('a named student gets their notice; a family with no children still sees school-wide ones', async () => {
    expect(await feedFor([child(900, JR3, B)])).toEqual([4, 5]);
    expect(await feedFor([])).toEqual([4]);
  });

  it('a child with no class or section only matches notices that leave those open', async () => {
    expect(await feedFor([child(40, null, null)])).toEqual([4]);
  });
});
