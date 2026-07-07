import { PrismaService } from '../../../prisma/prisma.service';

function getPrefixByCampusName(name: string, campusId: number): string {
  const uname = name.toUpperCase();
  if (uname.includes('KANEEZ FATIMA') || campusId === 2) return 'KF-A';
  if (uname.includes('NORTH NAZIMABAD') || campusId === 3) return 'A-N';
  return '';
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

  const campus = await prisma.campuses.findUnique({
    where: { id: campusId },
    select: { campus_name: true, campus_prefix: true },
  });

  const defaultPrefix = isALevel
    ? 'A-'
    : (campus?.campus_prefix || (campus ? getPrefixByCampusName(campus.campus_name, campusId) : ''));

  const students = await prisma.students.findMany({
    where: { campus_id: campusId, gr_number: { not: null }, deleted_at: null },
    select: { gr_number: true },
    orderBy: { cc: 'desc' },
    take: 500,
  });

  let maxNum = 0;
  let mainPrefix = defaultPrefix;

  for (const s of students) {
    if (!s.gr_number) continue;
    const match = s.gr_number.match(/^(.*?)([0-9]+)$/);
    if (match) {
      const prefix = match[1];
      const num = parseInt(match[2], 10);
      const isThisGrALevel = prefix === 'A-';
      if (isThisGrALevel !== isALevel) continue;
      if (prefix !== defaultPrefix) continue;
      if (num > maxNum) {
        maxNum = num;
        mainPrefix = prefix || defaultPrefix;
      }
    } else if (!isALevel && defaultPrefix === '') {
      const num = parseInt(s.gr_number, 10);
      if (!isNaN(num) && num > maxNum) maxNum = num;
    }
  }

  if (reserved?.size) {
    for (const gr of reserved) {
      const match = gr.match(/^(.*?)([0-9]+)$/);
      if (!match) continue;
      const prefix = match[1];
      const num = parseInt(match[2], 10);
      const isThisGrALevel = prefix === 'A-';
      if (isThisGrALevel !== isALevel) continue;
      if (prefix !== defaultPrefix) continue;
      if (num > maxNum) {
        maxNum = num;
        mainPrefix = prefix || defaultPrefix;
      }
    }
  }

  let nextNum = maxNum + 1;
  let finalGr = `${mainPrefix}${nextNum}`;

  let isTaken = true;
  while (isTaken) {
    if (reserved?.has(finalGr)) {
      nextNum++;
      finalGr = `${mainPrefix}${nextNum}`;
      continue;
    }
    const existing = await prisma.students.findFirst({
      where: { campus_id: campusId, gr_number: finalGr, deleted_at: null },
      select: { cc: true },
    });
    if (!existing) {
      isTaken = false;
    } else {
      nextNum++;
      finalGr = `${mainPrefix}${nextNum}`;
    }
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
  const reserved = new Set<string>();
  const result: string[] = [];
  for (let i = 0; i < count; i++) {
    const gr = await computeNextGrNumber(prisma, campusId, isALevel, reserved);
    reserved.add(gr);
    result.push(gr);
  }
  return result;
}
