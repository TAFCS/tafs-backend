PART D — Graduation Class Tracking
Overview
Currently, when a student is graduated via the Bulk Promote page, the system sets class_id = null and status = GRADUATED. This permanently erases which class the student graduated from. We need to preserve this on the students record and backfill existing graduated students (all of whom graduated from class 19 — X).

D1 — Database Migration
Add a graduated_from_class_id column to the students table.

Prisma schema change (prisma/schema.prisma):

prisma
model students {
  // ... existing fields ...
  graduated_from_class_id    Int?                       // populated on graduation; null for active students
  // new relation
  graduated_from_class       classes?                   @relation("GraduatedFromClass", fields: [graduated_from_class_id], references: [id], onDelete: NoAction, onUpdate: NoAction)
}
model classes {
  // ... existing fields ...
  graduated_students         students[]                 @relation("GraduatedFromClass")
}
Migration command:

bash
npx prisma migrate dev --name add_graduated_from_class_id
D2 — Backend: Populate on Graduation
File: tafs-backend/src/modules/students/students.service.ts

In processPromotionForStudent(), inside the isGraduating block at line ~1130, update the students.update() call:

typescript
// BEFORE:
data: {
  status: StudentStatus.GRADUATED,
  class_id: null,
  academic_year: nextAcademicYear,
}
// AFTER:
data: {
  status: StudentStatus.GRADUATED,
  graduated_from_class_id: student.class_id,  // ← preserve before nulling
  class_id: null,
  academic_year: nextAcademicYear,
}
This is a 1-line change. No other logic changes needed.

D3 — Backfill Existing Graduated Students
All currently graduated students graduated from class 19 (X). Run a one-off Prisma script to backfill:

File: tafs-backend/src/seed-test.ts — or a dedicated script:

typescript
// Backfill: all students with status GRADUATED and no graduated_from_class_id → set to class 19
const result = await prisma.students.updateMany({
  where: {
    status: 'GRADUATED',
    graduated_from_class_id: null,
  },
  data: {
    graduated_from_class_id: 19,
  },
});
console.log(`Backfilled ${result.count} graduated students with class_id 19`);
IMPORTANT

Run this backfill after the migration is applied but before running any new graduations. The migration adds the column as nullable, so existing rows are safe until the backfill runs.

D4 — Frontend: Show Graduated Class
Update the Bulk Promote results table and any student profile views to display graduated_from_class_id where relevant.

Bulk Promote page (bulk-promote/page.tsx) — Results Table, "To Class" column:

tsx
// BEFORE:
{item.graduated
  ? <span className="..."><GraduationCap />Graduated</span>
  : resolveClassName(item.to_class_id, classMap)}
// AFTER:
{item.graduated
  ? <span className="..."><GraduationCap />Graduated from {resolveClassName(item.from_class_id, classMap)}</span>
  : resolveClassName(item.to_class_id, classMap)}
Also update the graduation hint badge (line ~472) to say:

Status → GRADUATED, class_id → null, graduated_from_class_id ← current class_id preserved.
Student profile / identity pages — Add a read-only "Graduated From" field that shows graduated_from_class_id when status === 'GRADUATED'.

D5 — Expose graduated_from_class_id in API Responses
The students endpoint already returns the full student record. Verify VOUCHER_INCLUDE-style includes in students.service.ts propagate the new field. Since it's a direct column (not a relation), it will be included automatically in all findUnique/findMany calls.

For the relation (the class name), add to student selects:

typescript
graduated_from_class: {
  select: { id: true, description: true, class_code: true }
}
D6 — Execution Order for Part D
| # | Task | Files | Risk | Effort | |---|---|---|---| | 1 | Add graduated_from_class_id to schema + run migration | schema.prisma | Low | Low | | 2 | Update processPromotionForStudent() to write graduated_from_class_id | students.service.ts:1131 | Zero | Trivial | | 3 | Run backfill script for existing graduated students (class 19) | new script / seed-test.ts | Low | Trivial | | 4 | Update bulk-promote frontend results table label | bulk-promote/page.tsx | Low | Trivial | | 5 | Show graduated_from_class in student profile views | identity pages | Low | Low |