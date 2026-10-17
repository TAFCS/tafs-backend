import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { normalizePkPhone } from '../../common/utils/phone.util';

/** Largest value a Postgres INT4 holds; a longer number can't be a CC or family id. */
const INT4_MAX = 2_147_483_647;

export type StudentSearchHit = { cc: number; rank: number; matched_on: string };

/**
 * TAFSD-344: every student a search text could mean, best match first.
 *
 * Matches the student (CC exactly, name, GR, B-form / CNIC, own phones), their
 * guardians (name, CNIC, phone, WhatsApp, work and extra phones) and their
 * family (household name, family number, legacy id, home phone). Phones
 * compare on digits with any 0 / 92 / +92 prefix dropped, so 0300-1234567,
 * 3001234567 and +923001234567 are the same number; CNICs compare on digits,
 * dashes or not. Short numbers (5 digits or fewer) only match CC, GR and
 * family number, since they would hit half the phone book otherwise.
 *
 * Scope is NOT applied here: callers narrow the returned CCs with their own
 * scoped where, so this can never widen what a user may see.
 */
export async function findStudentSearchHits(
  prisma: PrismaService | Prisma.TransactionClient,
  rawQuery: string,
  limit = 500,
): Promise<StudentSearchHit[]> {
  const q = rawQuery.trim();
  if (!q) return [];
  const like = `%${q}%`;
  const digits = q.replace(/\D/g, '');
  const onlyDigits = /^[\d\s\-+()]+$/.test(q) && digits.length > 0;
  const number = /^\d+$/.test(q) && Number(q) <= INT4_MAX ? Number(q) : null;
  // A phone fragment without its country / trunk prefix.
  const phoneCore = normalizePkPhone(digits).replace(/^0/, '');
  const phoneLike = `%${phoneCore}%`;
  const digitsLike = `%${digits}%`;
  const D = (col: Prisma.Sql) => Prisma.sql`regexp_replace(coalesce(${col}::text, ''), '\\D', '', 'g')`;

  const parts: Prisma.Sql[] = [];
  if (number != null) {
    parts.push(Prisma.sql`SELECT s.cc, 1, 'C.C.'::text FROM public.students s WHERE s.cc = ${number}`);
  }
  if (!onlyDigits || q.length >= 2) {
    parts.push(Prisma.sql`SELECT s.cc, 2, 'Name' FROM public.students s WHERE s.full_name ILIKE ${like}`);
  }
  parts.push(Prisma.sql`SELECT s.cc, 3, 'G.R. ' || s.gr_number FROM public.students s WHERE s.gr_number ILIKE ${like}`);
  if (onlyDigits && digits.length >= 5) {
    parts.push(Prisma.sql`SELECT s.cc, 4, 'B-form / CNIC' FROM public.students s WHERE ${D(Prisma.sql`s.cnic`)} LIKE ${digitsLike}`);
  }
  if (onlyDigits && phoneCore.length >= 7) {
    parts.push(Prisma.sql`
      SELECT s.cc, 5, 'Student phone' FROM public.students s
      WHERE ${D(Prisma.sql`s.primary_phone`)} LIKE ${phoneLike}
         OR ${D(Prisma.sql`s.whatsapp_number`)} LIKE ${phoneLike}
         OR ${D(Prisma.sql`s.home_phone`)} LIKE ${phoneLike}`);
  }
  if (!onlyDigits && q.length >= 3) {
    parts.push(Prisma.sql`
      SELECT sg.student_id, 6, initcap(lower(coalesce(sg.relationship, 'Guardian'))) || ': ' || g.full_name
      FROM public.student_guardians sg JOIN public.guardians g ON g.id = sg.guardian_id
      WHERE g.deleted_at IS NULL AND g.full_name ILIKE ${like}`);
  }
  if (onlyDigits && digits.length >= 5) {
    parts.push(Prisma.sql`
      SELECT sg.student_id, 7, initcap(lower(coalesce(sg.relationship, 'Guardian'))) || ' CNIC: ' || g.full_name
      FROM public.student_guardians sg JOIN public.guardians g ON g.id = sg.guardian_id
      WHERE g.deleted_at IS NULL AND ${D(Prisma.sql`g.cnic`)} LIKE ${digitsLike}`);
  }
  if (onlyDigits && phoneCore.length >= 7) {
    parts.push(Prisma.sql`
      SELECT sg.student_id, 8, initcap(lower(coalesce(sg.relationship, 'Guardian'))) || ' phone: ' || g.full_name
      FROM public.student_guardians sg JOIN public.guardians g ON g.id = sg.guardian_id
      WHERE g.deleted_at IS NULL AND (
            ${D(Prisma.sql`g.primary_phone`)} LIKE ${phoneLike}
         OR ${D(Prisma.sql`g.whatsapp_number`)} LIKE ${phoneLike}
         OR ${D(Prisma.sql`g.work_phone`)} LIKE ${phoneLike}
         OR ${D(Prisma.sql`g.additional_phones`)} LIKE ${phoneLike})`);
  }
  {
    const famConds: Prisma.Sql[] = [];
    if (!onlyDigits && q.length >= 3) famConds.push(Prisma.sql`f.household_name ILIKE ${like}`);
    if (number != null) famConds.push(Prisma.sql`f.id = ${number}`);
    if (q.length >= 3) famConds.push(Prisma.sql`f.legacy_pid ILIKE ${like}`);
    if (onlyDigits && phoneCore.length >= 7) famConds.push(Prisma.sql`${D(Prisma.sql`f.home_phone`)} LIKE ${phoneLike}`);
    if (famConds.length) {
      parts.push(Prisma.sql`
        SELECT s.cc, 9, 'Family: ' || f.household_name || ' (#' || f.id || ')'
        FROM public.students s JOIN public.families f ON f.id = s.family_id
        WHERE f.deleted_at IS NULL AND (${Prisma.join(famConds, ' OR ')})`);
    }
  }
  if (!parts.length) return [];

  const rows = await prisma.$queryRaw<{ cc: number; hit_rank: number; why: string }[]>(Prisma.sql`
    WITH m(cc, hit_rank, why) AS (${Prisma.join(parts, " UNION ALL ")})
    SELECT m.cc, min(m.hit_rank)::int AS hit_rank, (array_agg(m.why ORDER BY m.hit_rank))[1] AS why
    FROM m JOIN public.students s ON s.cc = m.cc AND s.deleted_at IS NULL
    GROUP BY m.cc
    ORDER BY min(m.hit_rank), max(s.full_name)
    LIMIT ${limit}
  `);
  return rows.map((r) => ({ cc: Number(r.cc), rank: Number(r.hit_rank), matched_on: r.why }));
}
