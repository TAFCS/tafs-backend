/**
 * TAFSD-546. Pure classification of "more than one fee head for the same
 * thing", so the read-only audit, the finance review sheet and the cleanup all
 * judge a group the same way. No database access here; see load.ts.
 *
 * Two kinds of group are checked:
 *
 * - same_fee_date: same student, fee type, fee date and academic year. This is
 *   the shape the repeated bulk add (TAFSD-545) produced.
 * - same_month_other_dates: same student, fee type, academic year and target
 *   month, but the copies sit on different fee dates. The ticket's acceptance
 *   ("no student has two billable copies of the same month's fee") is about
 *   the month, not the fee date, so this is checked too.
 *
 * Several copies are NOT a duplicate in two common cases, and the classifier
 * must recognise both before it calls anything a duplicate:
 *
 * 1. A voucher split. splitPartiallyPaid() turns one head into a PAID
 *    "PARTIAL PAYMENT OF" row plus the original row as a "BALANCE PAYMENT OF"
 *    row, on the same fee date and month. The PARTIAL row points at the
 *    balance through split_pair_id (older rows predate the column). One head
 *    split into a paid part and a balance is one fee, so a split family counts
 *    as one copy.
 * 2. Several months billed on one fee date (a whole year, or two months
 *    together). Each target month appears once, so nothing is repeated.
 *
 * What remains — a target month with two or more independent copies — is a
 * duplicate, and how it can be cleaned depends on whether any copy has been
 * billed or paid.
 */

export const LIVE_VOUCHER_STATUSES = [
  'UNPAID',
  'OVERDUE',
  'EXPIRED',
  'PARTIALLY_PAID',
] as const;

export interface CopyVoucher {
  id: number;
  status: string;
  voucher_number: string | null;
  issue_date: string | null;
}

export interface CopyAllocation {
  id: number;
  deposit_id: number;
  voucher_id: number | null;
  amount: number;
  type: string;
  deposit_date: string | null;
}

/** One student_fees row, with everything that decides whether it may be removed. */
export interface HeadCopy {
  id: number;
  student_id: number;
  fee_type_id: number | null;
  fee_date: string | null; // YYYY-MM-DD
  academic_year: string;
  target_month: number;
  month: number | null;
  status: string; // fee_status_enum
  amount: number; // student_fees.amount (the receivable; fallback amount_before_discount)
  amount_paid: number;
  description_prefix: string | null;
  split_pair_id: number | null;
  installment_id: number | null;
  vouchers: CopyVoucher[];
  allocations: CopyAllocation[];
}

export type GroupKind = 'same_fee_date' | 'same_month_other_dates';

export type Verdict =
  | 'LEGIT' // several copies, but no target month is repeated (splits / several months)
  | 'DUP_UNBILLED' // a month repeated, no copy billed or paid: remove the extras
  | 'DUP_ONE_BILLED' // a month repeated, exactly one copy billed or paid: remove the unbilled extras
  | 'DUP_NEEDS_REVERSAL' // a month repeated and two or more copies billed or paid
  | 'UNCLEAR'; // needs a person to look

export const VERDICT_LABEL: Record<Verdict, string> = {
  LEGIT: 'Legitimate',
  DUP_UNBILLED: 'Duplicate, no copy billed or paid',
  DUP_ONE_BILLED: 'Duplicate, one copy billed or paid',
  DUP_NEEDS_REVERSAL: 'Duplicate, more than one copy billed or paid',
  UNCLEAR: 'Unclear, needs review',
};

/** Worst first: a group's verdict is the worst of its months. */
const SEVERITY: Verdict[] = [
  'DUP_NEEDS_REVERSAL',
  'UNCLEAR',
  'DUP_ONE_BILLED',
  'DUP_UNBILLED',
  'LEGIT',
];

/** How far a copy (a split family counts as one) has got into the money flow. */
export type FamilyState =
  | 'clean' // NOT_ISSUED, nothing paid, never on any voucher, no deposit
  | 'billed' // on a live voucher, no money against it
  | 'paid' // money against it (deposit allocation, amount_paid, or a PAID voucher)
  | 'odd'; // waived, instalment-linked, only on VOID vouchers, or a status nothing explains

export interface Family {
  root: number;
  rows: HeadCopy[];
  state: FamilyState;
  odd_reasons: string[];
  amount: number; // sum of the rows' amount (a split family adds back up to the original head)
  paid: number;
  is_split: boolean;
}

export interface MonthResult {
  target_month: number;
  families: Family[];
  verdict: Verdict;
  keep: number | null; // family root to keep
  remove: number[]; // student_fees ids the cleanup may delete (DUP_UNBILLED / DUP_ONE_BILLED only)
  steps: string[]; // plain-words actions for finance
  notes: string[];
}

export interface GroupResult {
  kind: GroupKind;
  key: string;
  student_id: number;
  fee_type_id: number | null;
  academic_year: string;
  fee_date: string | null; // same_fee_date only
  target_month: number | null; // same_month_other_dates only
  copies: HeadCopy[];
  months: MonthResult[];
  verdict: Verdict;
  reason: string;
  action: string;
  remove: number[];
  has_unpaid_copy: boolean; // at least one copy not PAID / WAIVED (the ticket's "113")
  billable_twice: boolean; // some month has two copies still owed or still to be billed
}

const isPartial = (r: HeadCopy) =>
  !!r.description_prefix &&
  r.description_prefix.toUpperCase().startsWith('PARTIAL');
const isBalance = (r: HeadCopy) =>
  !!r.description_prefix &&
  r.description_prefix.toUpperCase().startsWith('BALANCE');
const money = (n: number) => Math.round(n * 100) / 100;
const isLive = (s: string) =>
  (LIVE_VOUCHER_STATUSES as readonly string[]).includes(s);

/** Still owed, or still to be billed: the copy would cost the family money. */
export function owes(r: HeadCopy): boolean {
  if (r.status === 'PAID' || r.status === 'WAIVED' || r.status === 'DISCOUNT')
    return false;
  return money(r.amount - r.amount_paid) > 0;
}

/**
 * Collapse split families. A PARTIAL row belongs to the balance its
 * split_pair_id names (even when the balance has moved to another fee date and
 * is not in `rows`). A legacy PARTIAL row with no pointer joins the balance row
 * of the same target month when there is exactly one; otherwise it stands
 * alone.
 */
export function buildFamilies(rows: HeadCopy[]): Family[] {
  const byRoot = new Map<number, HeadCopy[]>();
  const balancesByMonth = new Map<number, HeadCopy[]>();
  for (const r of rows) {
    if (isBalance(r))
      balancesByMonth.set(r.target_month, [
        ...(balancesByMonth.get(r.target_month) ?? []),
        r,
      ]);
  }
  for (const r of rows) {
    let root = r.id;
    if (isPartial(r)) {
      if (r.split_pair_id != null) root = r.split_pair_id;
      else {
        const bal = balancesByMonth.get(r.target_month) ?? [];
        if (bal.length === 1) root = bal[0].id;
      }
    }
    byRoot.set(root, [...(byRoot.get(root) ?? []), r]);
  }
  return [...byRoot.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([root, fam]) =>
      describeFamily(
        root,
        fam.sort((a, b) => a.id - b.id),
      ),
    );
}

function describeFamily(root: number, rows: HeadCopy[]): Family {
  const odd: string[] = [];
  let anyMoney = false;
  let anyLive = false;
  let anyVoucher = false;
  for (const r of rows) {
    if (r.status === 'WAIVED') odd.push(`#${r.id} is waived`);
    if (r.installment_id != null)
      odd.push(`#${r.id} belongs to instalment plan ${r.installment_id}`);
    if (
      r.amount_paid > 0 ||
      r.allocations.length > 0 ||
      r.status === 'PAID' ||
      r.status === 'PARTIALLY_PAID'
    )
      anyMoney = true;
    for (const v of r.vouchers) {
      anyVoucher = true;
      if (v.status === 'PAID') anyMoney = true;
      if (isLive(v.status)) anyLive = true;
    }
    if (
      r.status === 'ISSUED' &&
      !r.vouchers.some((v) => isLive(v.status) || v.status === 'PAID')
    ) {
      odd.push(`#${r.id} is ISSUED but on no live voucher`);
    }
    if (r.status === 'NOT_ISSUED' && r.vouchers.some((v) => isLive(v.status))) {
      odd.push(
        `#${r.id} is NOT_ISSUED but sits on live voucher ${r.vouchers
          .filter((v) => isLive(v.status))
          .map((v) => v.id)
          .join(', ')}`,
      );
    }
  }
  let state: FamilyState;
  if (odd.length) state = 'odd';
  else if (anyMoney) state = 'paid';
  else if (anyLive) state = 'billed';
  else if (anyVoucher) {
    // Only on VOID vouchers. A VOID voucher can come back when the voucher
    // that superseded it is deleted (finance CLAUDE.md, Rule A), so the
    // head is not free to delete.
    odd.push(
      `only on VOID voucher(s) ${rows.flatMap((r) => r.vouchers.map((v) => v.id)).join(', ')}`,
    );
    state = 'odd';
  } else if (rows.every((r) => r.status === 'NOT_ISSUED')) state = 'clean';
  else {
    odd.push(`status ${rows.map((r) => r.status).join('/')} with no voucher`);
    state = 'odd';
  }
  return {
    root,
    rows,
    state,
    odd_reasons: odd,
    amount: money(rows.reduce((s, r) => s + r.amount, 0)),
    paid: money(rows.reduce((s, r) => s + r.amount_paid, 0)),
    is_split: rows.some((r) => isPartial(r) || isBalance(r)),
  };
}

const describeCopy = (f: Family): string => {
  const ids = f.rows.map((r) => `#${r.id}`).join(' + ');
  const live = [
    ...new Set(
      f.rows.flatMap((r) =>
        r.vouchers
          .filter((v) => isLive(v.status) || v.status === 'PAID')
          .map((v) => `voucher ${v.id} (${v.status})`),
      ),
    ),
  ];
  const bits = [`${ids} Rs ${f.amount}`];
  if (f.paid > 0) bits.push(`Rs ${f.paid} paid`);
  if (live.length) bits.push(`on ${live.join(', ')}`);
  if (f.state === 'clean') bits.push('not billed');
  return bits.join(', ');
};

/** Decide one target month's copies. */
export function classifyMonth(
  target_month: number,
  rows: HeadCopy[],
): MonthResult {
  const families = buildFamilies(rows);
  const base = {
    target_month,
    families,
    steps: [] as string[],
    notes: [] as string[],
  };
  if (families.length <= 1) {
    return {
      ...base,
      verdict: 'LEGIT',
      keep: families[0]?.root ?? null,
      remove: [],
    };
  }

  const odd = families.filter((f) => f.state === 'odd');
  if (odd.length) {
    return {
      ...base,
      verdict: 'UNCLEAR',
      keep: null,
      remove: [],
      notes: odd.flatMap((f) => f.odd_reasons),
      steps: [
        `Look at copies ${families.map(describeCopy).join('; ')} before changing anything.`,
      ],
    };
  }

  const amounts = new Set(families.map((f) => f.amount));
  if (amounts.size > 1) {
    return {
      ...base,
      verdict: 'UNCLEAR',
      keep: null,
      remove: [],
      notes: [
        `copies have different amounts (${[...amounts].join(', ')}), so they may not be the same fee`,
      ],
      steps: [
        `Confirm whether ${families.map(describeCopy).join('; ')} are the same fee before removing one.`,
      ],
    };
  }

  const engaged = families.filter(
    (f) => f.state === 'billed' || f.state === 'paid',
  );
  const clean = families.filter((f) => f.state === 'clean');

  if (engaged.length === 0) {
    const [keep, ...extra] = families; // lowest id first
    return {
      ...base,
      verdict: 'DUP_UNBILLED',
      keep: keep.root,
      remove: extra.flatMap((f) => f.rows.map((r) => r.id)),
      steps: [
        `Keep #${keep.root}. Remove the unbilled copy ${extra.map((f) => `#${f.root}`).join(', ')}.`,
      ],
    };
  }

  if (engaged.length === 1) {
    const keep = engaged[0];
    const where = keep.state === 'paid' ? 'paid' : 'on a live voucher';
    return {
      ...base,
      verdict: 'DUP_ONE_BILLED',
      keep: keep.root,
      remove: clean.flatMap((f) => f.rows.map((r) => r.id)),
      steps: [
        `Keep ${describeCopy(keep)} (${where}). Remove the unbilled copy ${clean.map((f) => `#${f.root}`).join(', ')}. No voucher or deposit changes.`,
      ],
    };
  }

  // Two or more copies billed or paid. Keep the one with the most cash on it
  // (the earliest on a tie); every other engaged copy must be unwound through
  // the app's own flows, newest deposit first, before its row can go.
  const keep = [...engaged].sort(
    (a, b) => b.paid - a.paid || a.root - b.root,
  )[0];
  const steps: string[] = [`Keep ${describeCopy(keep)}.`];
  for (const f of engaged.filter((x) => x !== keep)) {
    const allocs = f.rows.flatMap((r) => r.allocations);
    const deposits = [
      ...new Map(allocs.map((a) => [a.deposit_id, a])).values(),
    ].sort(
      (a, b) =>
        (b.deposit_date ?? '').localeCompare(a.deposit_date ?? '') ||
        b.deposit_id - a.deposit_id,
    );
    const vouchers = [
      ...new Map(
        f.rows
          .flatMap((r) => r.vouchers)
          .filter((v) => isLive(v.status) || v.status === 'PAID')
          .map((v) => [v.id, v]),
      ).values(),
    ];
    const sharedWithKeeper = vouchers.filter((v) =>
      keep.rows.some((k) => k.vouchers.some((kv) => kv.id === v.id)),
    );
    const ownVouchers = vouchers.filter((v) => !sharedWithKeeper.includes(v));
    const parts: string[] = [`For ${describeCopy(f)}:`];
    if (deposits.length) {
      parts.push(
        `reverse deposit ${deposits.map((d) => `D${d.deposit_id}`).join(', then ')} first (latest first, and only once every newer deposit for this student is reversed)` +
          (f.paid > 0
            ? `, or move the Rs ${f.paid} to the copy being kept`
            : ''),
      );
    }
    if (sharedWithKeeper.length) {
      parts.push(
        `regenerate voucher ${sharedWithKeeper.map((v) => v.id).join(', ')} without this copy (it bills the fee twice)`,
      );
    }
    if (ownVouchers.length) {
      parts.push(
        `delete or regenerate voucher ${ownVouchers.map((v) => `${v.id} (${v.status})`).join(', ')} (newest voucher first)`,
      );
    }
    parts.push('then remove the copy');
    steps.push(parts.join(' '));
  }
  if (clean.length)
    steps.push(
      `Remove the unbilled copy ${clean.map((f) => `#${f.root}`).join(', ')}.`,
    );
  return {
    ...base,
    verdict: 'DUP_NEEDS_REVERSAL',
    keep: keep.root,
    remove: [],
    steps,
  };
}

export function groupKey(kind: GroupKind, r: HeadCopy): string {
  return kind === 'same_fee_date'
    ? `${r.student_id}|${r.fee_type_id ?? '-'}|${r.academic_year}|${r.fee_date ?? '-'}`
    : `${r.student_id}|${r.fee_type_id ?? '-'}|${r.academic_year}|m${r.target_month}`;
}

/** Classify one group of copies (all sharing the group key). */
export function classifyGroup(
  kind: GroupKind,
  copies: HeadCopy[],
): GroupResult {
  const first = copies[0];
  const byMonth = new Map<number, HeadCopy[]>();
  for (const c of copies)
    byMonth.set(c.target_month, [...(byMonth.get(c.target_month) ?? []), c]);
  const months = [...byMonth.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([m, rows]) => classifyMonth(m, rows));

  let verdict: Verdict =
    SEVERITY.find((v) => months.some((m) => m.verdict === v)) ?? 'LEGIT';
  let reason: string;
  let action: string;

  if (kind === 'same_month_other_dates' && verdict !== 'LEGIT') {
    // The same month on two fee dates is as often a head filed under the
    // wrong academic year or month as a real second charge (CC 7976: paid
    // copies on 2026-07-01 labelled June/July 2026-2027 beside the real
    // June/July 2027 heads). Removing either blind can delete a fee the
    // family genuinely owes, so these always go to a person.
    const families = months[0].families;
    const dates = [...new Set(copies.map((c) => c.fee_date ?? '-'))].sort();
    verdict = 'UNCLEAR';
    reason = `the same month appears on ${dates.length} fee dates (${dates.join(', ')})`;
    const paid = families.filter((f) => f.state === 'paid');
    const clean = families.filter((f) => f.state === 'clean');
    const owing = families.filter((f) => f.rows.some(owes));
    const at = (f: Family) => `#${f.root} (fee date ${f.rows[0].fee_date})`;
    const sameAmount = new Set(families.map((f) => f.amount)).size === 1;
    if (paid.length && clean.length && owing.length === clean.length) {
      action =
        `Check whether paid copy ${paid.map(at).join(', ')} carries the wrong academic year or month. ` +
        `If it really is this month, remove the unbilled copy ${clean.map(at).join(', ')} before it is billed; if it is mislabelled, correct its label instead.`;
    } else if (owing.length === 0) {
      action =
        `Every copy is paid (Rs ${money(families.reduce((s, f) => s + f.paid, 0))} in all), so nobody is billed again. ` +
        (sameAmount
          ? 'Same amount on each: check whether the fee was collected twice and refund if so.'
          : 'Different amounts: most likely one fee paid in parts; confirm, and no action is needed.') +
        ` Copies: ${families.map(describeCopy).join('; ')}.`;
    } else {
      action =
        `Copy ${owing.map(at).join(', ')} is still owed while another copy of the same month exists (${families.map(describeCopy).join('; ')}). ` +
        (sameAmount
          ? 'Confirm it is not a second charge before the family pays it.'
          : 'Different amounts: confirm it is the next part of one fee, not a second charge.');
    }
    return finish();
  }

  if (verdict === 'LEGIT') {
    const families = months.flatMap((m) => m.families);
    const split = families.some((f) => f.is_split);
    const allInstalments = copies.every((c) => c.installment_id != null);
    const parts: string[] = [];
    if (allInstalments) parts.push('instalment plan');
    if (split)
      parts.push('a voucher split (paid part plus balance) counted once');
    if (months.length >= 12)
      parts.push(`whole year on one fee date (${months.length} months)`);
    else if (months.length > 1) parts.push(`${months.length} different months`);
    reason = parts.join('; ') || 'no repeated month';
    action = 'No action.';
    return finish();
  }

  const bad = months.filter((m) => m.verdict !== 'LEGIT');
  reason = bad
    .map(
      (m) =>
        `month ${m.target_month}: ${m.families.length} copies` +
        (m.notes.length ? ` (${m.notes.join('; ')})` : ''),
    )
    .join('; ');
  action = bad.flatMap((m) => m.steps).join(' ');
  return finish();

  function finish(): GroupResult {
    const remove =
      verdict === 'DUP_UNBILLED' || verdict === 'DUP_ONE_BILLED'
        ? months.flatMap((m) => m.remove)
        : [];
    const billableTwice = months.some(
      (m) => m.families.filter((f) => f.rows.some(owes)).length >= 2,
    );
    return {
      kind,
      key: groupKey(kind, first),
      student_id: first.student_id,
      fee_type_id: first.fee_type_id,
      academic_year: first.academic_year,
      fee_date: kind === 'same_fee_date' ? first.fee_date : null,
      target_month:
        kind === 'same_month_other_dates' ? first.target_month : null,
      copies,
      months,
      verdict,
      reason,
      action,
      remove,
      has_unpaid_copy: copies.some(
        (c) => c.status !== 'PAID' && c.status !== 'WAIVED',
      ),
      billable_twice: billableTwice,
    };
  }
}

/**
 * Build every suspect group from a flat list of heads (non-discount,
 * non-surcharge). A same_fee_date group is any key with two or more rows. A
 * same_month_other_dates group is any (student, fee type, year, month) whose
 * copies, after collapsing split families, are two or more and span more than
 * one fee date. Same-date repeats are already covered by the first kind.
 */
export function buildGroups(rows: HeadCopy[]): GroupResult[] {
  const out: GroupResult[] = [];
  const sameDate = new Map<string, HeadCopy[]>();
  const sameMonth = new Map<string, HeadCopy[]>();
  for (const r of rows) {
    const a = groupKey('same_fee_date', r);
    sameDate.set(a, [...(sameDate.get(a) ?? []), r]);
    const b = groupKey('same_month_other_dates', r);
    sameMonth.set(b, [...(sameMonth.get(b) ?? []), r]);
  }
  for (const g of sameDate.values())
    if (g.length > 1) out.push(classifyGroup('same_fee_date', g));
  for (const g of sameMonth.values()) {
    if (g.length < 2) continue;
    const families = buildFamilies(g);
    if (families.length < 2) continue;
    const dates = new Set(families.map((f) => f.rows[0].fee_date ?? '-'));
    if (dates.size < 2) continue;
    // Instalments of one fee type are often all labelled with the plan's
    // first month; they are a plan, not a duplicate.
    if (g.every((c) => c.installment_id != null)) {
      out.push({
        ...classifyGroup('same_month_other_dates', g),
        verdict: 'LEGIT',
        reason: 'instalment plan',
        action: 'No action.',
        remove: [],
      });
      continue;
    }
    out.push(classifyGroup('same_month_other_dates', g));
  }
  return out;
}
