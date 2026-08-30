import { PrismaService } from '../../../prisma/prisma.service';

function getPrefixByCampusName(name: string, campusId: number): string {
  const uname = name.toUpperCase();
  if (uname.includes('KANEEZ FATIMA') || campusId === 2) return 'KF-A';
  if (uname.includes('NORTH NAZIMABAD') || campusId === 3) return 'A-N';
  return '';
}

/**
 * Helper to determine whether an academic system or grade string corresponds to A-Levels.
 */
export function checkIsALevel(
  academicSystem?: string | null,
  requestedGrade?: string | null,
  hasALevelDetails?: boolean,
): boolean {
  if (hasALevelDetails) return true;

  const sys = (academicSystem || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const gr = (requestedGrade || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  if (sys.includes('alevel')) return true;

  const aLevelGradeKeys = ['a1', 'a2', 'as', 'alevel', 'alevels', 'xia', 'xiia'];
  if (
    aLevelGradeKeys.some(
      (key) =>
        gr === key ||
        gr.startsWith('a1') ||
        gr.startsWith('a2') ||
        gr.startsWith('as') ||
        gr.includes('alevel'),
    )
  ) {
    return true;
  }

  return false;
}

/** Non-A-Level or A-Level GR prefix for a campus (KF-A / A-N / A- / '' for Johar). */
export async function resolveCampusGrPrefix(
  prisma: any,
  campusId: number | null,
  isALevel = false,
): Promise<string> {
  if (!campusId) return '';
  if (isALevel) return 'A-';
  const campus = await prisma.campuses.findUnique({
    where: { id: campusId },
    select: { campus_name: true, campus_prefix: true },
  });
  if (!campus) return '';
  return campus.campus_prefix || getPrefixByCampusName(campus.campus_name, campusId);
}

/**
 * Format a raw G.R. number string with the appropriate campus prefix.
 * e.g., for Kaneez Fatima (prefix "KF-A"):
 *   - "1234" -> "KF-A1234"
 *   - "kf-a1234" -> "KF-A1234"
 *   - "KF-A1234" -> "KF-A1234"
 * e.g., for A-Levels (prefix "A-"):
 *   - "1234" -> "A-1234"
 *   - "a1234" -> "A-1234"
 *   - "A-1234" -> "A-1234"
 */
export async function formatGrNumberWithPrefix(
  prisma: any,
  campusId: number | null,
  rawGr: string | null | undefined,
  isALevel = false,
): Promise<string> {
  const trimmed = rawGr?.trim();
  if (!trimmed) return '';
  if (!campusId) return trimmed;

  const prefix = await resolveCampusGrPrefix(prisma, campusId, isALevel);
  if (!prefix) return trimmed;

  const cleanPrefix = prefix.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  const cleanTrimmed = trimmed.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();

  // Handle A-Level GRs (e.g. A-1234, A1234, a1234, a-1234)
  if (isALevel) {
    const aMatch = trimmed.match(/^(?:a-?)?(\d+)$/i);
    if (aMatch) {
      return `A-${aMatch[1]}`;
    }
  }

  // If already starts with the prefix (with or without hyphens/spaces)
  if (cleanTrimmed.startsWith(cleanPrefix)) {
    const digits = cleanTrimmed.slice(cleanPrefix.length);
    if (/^\d+$/.test(digits)) {
      return `${prefix}${digits}`;
    }
  }

  // If input is purely numeric digits (e.g. "1234"), prepend campus/level prefix
  if (/^\d+$/.test(trimmed)) {
    return `${prefix}${trimmed}`;
  }

  return trimmed;
}

function resolveDefaultPrefix(
  isALevel: boolean,
  campus: { campus_name: string; campus_prefix: string | null } | null,
  campusId: number,
): string {
  if (isALevel) return 'A-';
  if (!campus) return '';
  return campus.campus_prefix || getPrefixByCampusName(campus.campus_name, campusId);
}

function parseMatchingGrNumber(
  gr: string,
  defaultPrefix: string,
  isALevel: boolean,
): number | null {
  const match = gr.match(/^(.*?)([0-9]+)$/);
  if (match) {
    const prefix = match[1];
    const num = parseInt(match[2], 10);
    const isThisGrALevel = prefix === 'A-';
    if (isThisGrALevel !== isALevel) return null;
    if (prefix !== defaultPrefix) return null;
    return Number.isFinite(num) ? num : null;
  }
  if (!isALevel && defaultPrefix === '') {
    const num = parseInt(gr, 10);
    return !isNaN(num) ? num : null;
  }
  return null;
}

/**
 * Load campus GR series once: max numeric value + set of existing GRs in that series.
 */
async function loadCampusGrSeries(
  prisma: PrismaService,
  campusId: number,
  isALevel: boolean,
): Promise<{ defaultPrefix: string; maxNum: number; existing: Set<string> }> {
  const campus = await prisma.campuses.findUnique({
    where: { id: campusId },
    select: { campus_name: true, campus_prefix: true },
  });
  const defaultPrefix = resolveDefaultPrefix(isALevel, campus, campusId);

  const students = await prisma.students.findMany({
    where: {
      campus_id: campusId,
      deleted_at: null,
      ...(isALevel
        ? { gr_number: { startsWith: 'A-' } }
        : defaultPrefix
          ? { gr_number: { startsWith: defaultPrefix } }
          : { gr_number: { not: null } }),
    },
    select: { gr_number: true },
  });

  const existing = new Set<string>();
  let maxNum = 0;

  for (const s of students) {
    if (!s.gr_number) continue;
    existing.add(s.gr_number);
    const num = parseMatchingGrNumber(s.gr_number, defaultPrefix, isALevel);
    if (num != null && num > maxNum) maxNum = num;
  }

  return { defaultPrefix, maxNum, existing };
}

/**
 * Returns the next available GR for a campus/level.
 * Pass `reserved` to avoid duplicates within the same batch (e.g. bulk promotion).
 */
export async function computeNextGrNumber(
  prisma: PrismaService,
  campusId: number | null,
  isALevel = false,
  reserved?: Set<string>,
): Promise<string> {
  if (!campusId) return '1';

  const { defaultPrefix, maxNum, existing } = await loadCampusGrSeries(
    prisma,
    campusId,
    isALevel,
  );

  let nextNum = maxNum + 1;
  let finalGr = `${defaultPrefix}${nextNum}`;

  while (existing.has(finalGr) || reserved?.has(finalGr)) {
    nextNum++;
    finalGr = `${defaultPrefix}${nextNum}`;
  }

  return finalGr;
}

/** Allocate the next N sequential GR numbers for a campus (e.g. A-101, A-102, …). */
export async function allocateSequentialGrNumbers(
  prisma: PrismaService,
  campusId: number | null,
  count: number,
  isALevel: boolean,
): Promise<string[]> {
  if (count <= 0) return [];
  if (!campusId) {
    return Array.from({ length: count }, (_, i) => String(i + 1));
  }

  const { defaultPrefix, maxNum, existing } = await loadCampusGrSeries(
    prisma,
    campusId,
    isALevel,
  );

  const result: string[] = [];
  let nextNum = maxNum + 1;

  while (result.length < count) {
    const candidate = `${defaultPrefix}${nextNum}`;
    nextNum++;
    if (existing.has(candidate)) continue;
    existing.add(candidate);
    result.push(candidate);
  }

  return result;
}
