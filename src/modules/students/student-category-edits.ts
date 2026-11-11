/**
 * TAFSD-475: giving, changing and taking off a student's special categories.
 * Used by the student edit (staff-editing) and the admission form (identity).
 */
import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { LEGACY_CATEGORY_CODES, categoryPrefix } from './student-benefits';

export interface CategoryEdit {
  code: string;
  /** true gives it, false takes it off, undefined only edits details it already has. */
  on?: boolean;
  reason?: string | null;
  until?: string | null;
  remind_from?: string | null;
}

export interface CategoryAuditChange {
  field: string;
  old_value: string | null;
  new_value: string | null;
}

/** The per-category fields older webapp builds send, as category edits. */
export function legacyCategoryEdits(dto: Record<string, unknown>): {
  edits: CategoryEdit[];
  keys: string[];
} {
  const edits: CategoryEdit[] = [];
  const keys: string[] = [];
  for (const code of LEGACY_CATEGORY_CODES) {
    const p = categoryPrefix(code);
    const k = {
      on: `is_${p}`,
      reason: `${p}_reason`,
      until: `${p}_until`,
      remind_from: `${p}_remind_from`,
    };
    const present = Object.values(k).filter((f) => dto[f] !== undefined);
    if (!present.length) continue;
    keys.push(...present);
    edits.push({
      code,
      on: dto[k.on] as boolean | undefined,
      reason: dto[k.reason] as string | null | undefined,
      until: dto[k.until] as string | null | undefined,
      remind_from: dto[k.remind_from] as string | null | undefined,
    });
  }
  return { edits, keys };
}

const day = (d: Date | string | null | undefined) =>
  d ? new Date(d).toISOString().slice(0, 10) : null;
const asDate = (v: string | null | undefined) => (v ? new Date(v) : null);

/**
 * Applies the edits inside `tx`. Giving a category needs a reason and an end
 * date, and the category must not be retired. Re-saving one the student holds
 * doesn't. Returns audit changes keyed the way they were before TAFSD-475
 * (student.is_fee_endowment, student.fee_endowment_until, …).
 */
export async function applyCategoryEdits(
  tx: Prisma.TransactionClient,
  studentCc: number,
  edits: CategoryEdit[],
): Promise<CategoryAuditChange[]> {
  if (!edits.length) return [];
  // The last edit for a code wins (legacy fields and `categories` together).
  const byCode = new Map<string, CategoryEdit>();
  for (const e of edits)
    byCode.set(e.code, { ...byCode.get(e.code), ...stripUndefined(e), code: e.code });

  const cats = await tx.student_categories.findMany({
    where: { code: { in: [...byCode.keys()] } },
  });
  const catByCode = new Map(cats.map((c) => [c.code, c]));
  const unknown = [...byCode.keys()].filter((c) => !catByCode.has(c));
  if (unknown.length)
    throw new BadRequestException(`Unknown special category: ${unknown.join(', ')}`);

  const held = await tx.student_category_assignments.findMany({
    where: { student_id: studentCc, category_id: { in: cats.map((c) => c.id) } },
  });
  const heldBy = new Map(held.map((a) => [a.category_id, a]));
  const changes: CategoryAuditChange[] = [];
  const log = (field: string, a: unknown, b: unknown) => {
    const o = a == null || a === '' ? null : String(a);
    const n = b == null || b === '' ? null : String(b);
    if (o !== n) changes.push({ field: `student.${field}`, old_value: o, new_value: n });
  };

  for (const [code, e] of byCode) {
    const cat = catByCode.get(code)!;
    const p = categoryPrefix(code);
    const cur = heldBy.get(cat.id);
    const reason = typeof e.reason === 'string' ? e.reason.trim() : e.reason;

    if (e.on === false) {
      if (!cur) continue;
      await tx.student_category_assignments.delete({ where: { id: cur.id } });
      log(`is_${p}`, 'true', 'false');
      log(`${p}_reason`, cur.reason, null);
      log(`${p}_until`, day(cur.until), null);
      log(`${p}_remind_from`, day(cur.remind_from), null);
      continue;
    }

    if (!cur) {
      if (e.on !== true) continue; // details for a category it doesn't hold
      if (!cat.is_active)
        throw new BadRequestException(`${cat.label} is retired and can't be given to more students`);
      if (!reason || !e.until)
        throw new BadRequestException(`${cat.label} students require a reason and an until date`);
      await tx.student_category_assignments.create({
        data: {
          student_id: studentCc,
          category_id: cat.id,
          reason,
          until: asDate(e.until),
          remind_from: asDate(e.remind_from),
        },
      });
      log(`is_${p}`, 'false', 'true');
      log(`${p}_reason`, null, reason);
      log(`${p}_until`, null, day(e.until));
      log(`${p}_remind_from`, null, day(e.remind_from));
      continue;
    }

    // Already held: a blank reason keeps the old one; dates change when sent.
    const data: Prisma.student_category_assignmentsUpdateInput = {};
    if (reason) data.reason = reason;
    if (e.until !== undefined) data.until = asDate(e.until);
    if (e.remind_from !== undefined) data.remind_from = asDate(e.remind_from);
    if (!Object.keys(data).length) continue;
    const before = { ...cur };
    await tx.student_category_assignments.update({ where: { id: cur.id }, data });
    if (data.reason !== undefined) log(`${p}_reason`, before.reason, reason);
    if (e.until !== undefined) log(`${p}_until`, day(before.until), day(e.until));
    if (e.remind_from !== undefined)
      log(`${p}_remind_from`, day(before.remind_from), day(e.remind_from));
  }
  return changes;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
