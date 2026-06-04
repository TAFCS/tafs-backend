import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

const CNIC_RE = /^\d{5}-\d{7}-\d{1}$/;
function isValidCnic(v: string | null | undefined): boolean {
  if (!v?.trim()) return false;
  return CNIC_RE.test(v.trim());
}

function cell(v: unknown): string {
  const s = String(v ?? '');
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const students = await prisma.students.findMany({
    where: { deleted_at: null, status: 'ENROLLED' },
    select: {
      cc: true, gr_number: true, full_name: true,
      campus_id: true, family_id: true,
      classes: { select: { description: true } },
    },
  });

  const links = await prisma.student_guardians.findMany({
    include: { guardians: { select: { full_name: true, cnic: true } } },
  });

  const guardianIndex = new Map<number, { father?: { full_name: string | null; cnic: string | null }; mother?: { full_name: string | null; cnic: string | null } }>();
  for (const l of links) {
    if (!guardianIndex.has(l.student_id)) guardianIndex.set(l.student_id, {});
    const rel = l.relationship.toLowerCase();
    if (rel === 'father') guardianIndex.get(l.student_id)!.father = l.guardians;
    if (rel === 'mother') guardianIndex.get(l.student_id)!.mother = l.guardians;
  }

  interface Row {
    student_cc: number;
    gr_number: string;
    full_name: string;
    class: string;
    campus_id: number | null;
    missing: string;
    father_name: string;
    father_cnic: string;
    mother_name: string;
    mother_cnic: string;
  }

  const rows: Row[] = [];

  for (const s of students) {
    const g = guardianIndex.get(s.cc) ?? {};

    const fatherName = g.father?.full_name ?? '';
    const fatherCnic = g.father?.cnic ?? '';
    const motherName = g.mother?.full_name ?? '';
    const motherCnic = g.mother?.cnic ?? '';

    const fatherCnicValid = isValidCnic(fatherCnic);
    const motherCnicValid = isValidCnic(motherCnic);

    const missingFather = !g.father || !fatherCnic || !fatherCnicValid;
    const missingMother = !g.mother || !motherCnic || !motherCnicValid;

    if (!missingFather && !missingMother) continue;

    const flags: string[] = [];
    if (!g.father)            flags.push('NO_FATHER');
    else if (!fatherCnic)     flags.push('FATHER_NO_CNIC');
    else if (!fatherCnicValid) flags.push('FATHER_INVALID_CNIC');
    if (!g.mother)            flags.push('NO_MOTHER');
    else if (!motherCnic)     flags.push('MOTHER_NO_CNIC');
    else if (!motherCnicValid) flags.push('MOTHER_INVALID_CNIC');

    rows.push({
      student_cc:  s.cc,
      gr_number:   s.gr_number ?? '',
      full_name:   s.full_name,
      class:       s.classes?.description ?? '',
      campus_id:   s.campus_id,
      missing:     flags.join(' | '),
      father_name: fatherName,
      father_cnic: fatherCnic,
      mother_name: motherName,
      mother_cnic: motherCnic,
    });
  }

  const headers = Object.keys(rows[0] ?? {}) as (keyof Row)[];
  const csv = [
    headers.map(cell).join(','),
    ...rows.map((r) => headers.map((h) => cell(r[h])).join(',')),
  ].join('\r\n') + '\r\n';

  const outPath = path.join(__dirname, '..', 'fathers-data', 'students_no_guardian.csv');
  fs.writeFileSync(outPath, csv, 'utf8');

  const noParent        = rows.filter(r => r.missing.includes('NO_FATHER') && r.missing.includes('NO_MOTHER')).length;
  const noFatherOnly    = rows.filter(r => r.missing.includes('NO_FATHER') && !r.missing.includes('NO_MOTHER') && !r.missing.includes('MOTHER')).length;
  const noMotherOnly    = rows.filter(r => !r.missing.includes('NO_FATHER') && !r.missing.includes('FATHER') && r.missing.includes('NO_MOTHER')).length;
  const cnicMissing     = rows.filter(r => r.missing.includes('NO_CNIC')).length;
  const cnicInvalid     = rows.filter(r => r.missing.includes('INVALID_CNIC')).length;

  console.log(`Total ENROLLED students:                   ${students.length}`);
  console.log(`Rows in CSV (any gap):                     ${rows.length}`);
  console.log(`  No parent at all:                        ${noParent}`);
  console.log(`  Has mother, missing father:              ${noFatherOnly}`);
  console.log(`  Has father, missing mother:              ${noMotherOnly}`);
  console.log(`  CNIC blank (guardian exists):            ${cnicMissing}`);
  console.log(`  CNIC dirty/invalid format:               ${cnicInvalid}`);
  console.log(`Written: ${outPath}`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
