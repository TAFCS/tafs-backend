/**
 * TAFSD-445: working Saturdays are marked per employee per date at the start
 * of each cycle, so anyone added later (a mid-cycle joiner, a rejoin, a move
 * to another campus or segment) is left without them. These helpers work out
 * which Saturdays their peers — same campus and segment, or same campus and
 * department when there is no segment — are marked for.
 */

export interface SaturdayPeer {
  id: number;
  campus_id: number | null;
  segment_id: number | null;
  department_id: number | null;
  join_date: Date | null;
  date_of_leaving: Date | null;
}

/** Peers need at least this many colleagues employed that day to suggest anything. */
export const MIN_PEERS = 2;

export function peerGroupKey(e: Pick<SaturdayPeer, 'campus_id' | 'segment_id' | 'department_id'>): string | null {
  if (e.campus_id == null) return null;
  if (e.segment_id != null) return `${e.campus_id}:s${e.segment_id}`;
  if (e.department_id != null) return `${e.campus_id}:d${e.department_id}`;
  return null;
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

function employedOn(e: SaturdayPeer, day: string): boolean {
  if (e.join_date && dayKey(e.join_date) > day) return false;
  if (e.date_of_leaving && dayKey(e.date_of_leaving) < day) return false;
  return true;
}

/**
 * For each employee: the Saturdays (YYYY-MM-DD, ascending) that more than
 * half of their peers employed that day are marked for, on days they were
 * employed themselves, and that they are not marked for yet.
 */
export function suggestSaturdays(
  employees: SaturdayPeer[],
  marks: { employee_id: number; date: Date }[],
): Map<number, string[]> {
  const marked = new Map<number, Set<string>>();
  const days = new Set<string>();
  for (const m of marks) {
    const k = dayKey(m.date);
    days.add(k);
    if (!marked.has(m.employee_id)) marked.set(m.employee_id, new Set());
    marked.get(m.employee_id)!.add(k);
  }
  const sortedDays = [...days].sort();
  const groups = new Map<string, SaturdayPeer[]>();
  for (const e of employees) {
    const key = peerGroupKey(e);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(e);
  }

  const out = new Map<number, string[]>();
  for (const e of employees) {
    const key = peerGroupKey(e);
    if (!key) continue;
    const group = groups.get(key)!;
    const mine = marked.get(e.id);
    const suggested: string[] = [];
    for (const day of sortedDays) {
      if (!employedOn(e, day) || mine?.has(day)) continue;
      const peers = group.filter((p) => p.id !== e.id && employedOn(p, day));
      if (peers.length < MIN_PEERS) continue;
      const onIt = peers.filter((p) => marked.get(p.id)?.has(day)).length;
      if (onIt * 2 > peers.length) suggested.push(day);
    }
    if (suggested.length) out.set(e.id, suggested);
  }
  return out;
}
