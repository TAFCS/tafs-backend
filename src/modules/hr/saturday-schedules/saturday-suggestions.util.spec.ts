import { peerGroupKey, suggestSaturdays, type SaturdayPeer } from './saturday-suggestions.util';

// TAFSD-445: a mid-cycle joiner gets the Saturdays their segment already works.

const D = (iso: string) => new Date(`${iso}T00:00:00Z`);
const peer = (id: number, over: Partial<SaturdayPeer> = {}): SaturdayPeer => ({
  id, campus_id: 2, segment_id: 5, department_id: 1, join_date: D('2024-01-01'), date_of_leaving: null, ...over,
});
const mark = (employee_id: number, iso: string) => ({ employee_id, date: D(iso) });

describe('suggestSaturdays', () => {
  // Three peers work 3, 17 and 24 Oct; the new teacher joined 10 Oct.
  const peers = [peer(1), peer(2), peer(3)];
  const marks = [1, 2, 3].flatMap((id) => [mark(id, '2026-10-03'), mark(id, '2026-10-17'), mark(id, '2026-10-24')]);

  it("suggests the segment's Saturdays from the joining date on", () => {
    const joiner = peer(9, { join_date: D('2026-10-10') });
    expect(suggestSaturdays([...peers, joiner], marks).get(9)).toEqual(['2026-10-17', '2026-10-24']);
  });

  it('leaves out dates already marked, and suggests nothing to someone fully marked', () => {
    const joiner = peer(9, { join_date: D('2026-10-10') });
    const out = suggestSaturdays([...peers, joiner], [...marks, mark(9, '2026-10-17')]);
    expect(out.get(9)).toEqual(['2026-10-24']);
    expect(out.has(1)).toBe(false);
  });

  it('needs more than half of the peers employed that day', () => {
    // Only 1 of 3 peers works 31 Oct: not a segment Saturday.
    const joiner = peer(9, { join_date: D('2026-10-10') });
    const out = suggestSaturdays([...peers, joiner], [...marks, mark(1, '2026-10-31')]);
    expect(out.get(9)).not.toContain('2026-10-31');
  });

  it('only compares within the same campus and segment, and needs at least 2 peers', () => {
    const otherSegment = peer(9, { segment_id: 6 });
    expect(suggestSaturdays([...peers, otherSegment], marks).has(9)).toBe(false);
    const lonePair = [peer(1), peer(9, { join_date: D('2026-10-10') })];
    expect(suggestSaturdays(lonePair, [mark(1, '2026-10-17')]).has(9)).toBe(false);
  });

  it('falls back to campus + department when there is no segment, and skips days after leaving', () => {
    expect(peerGroupKey({ campus_id: 2, segment_id: null, department_id: 1 })).toBe('2:d1');
    expect(peerGroupKey({ campus_id: null, segment_id: 5, department_id: 1 })).toBeNull();
    const leaver = peer(9, { date_of_leaving: D('2026-10-20') });
    expect(suggestSaturdays([...peers, leaver], marks).get(9)).toEqual(['2026-10-03', '2026-10-17']);
  });
});
