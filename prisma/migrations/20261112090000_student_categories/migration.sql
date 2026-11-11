-- TAFSD-475: special categories move from hard-coded columns on students to
-- their own tables, managed in School Setup. Additive only: the old
-- is_<category> / <category>_reason / _until / _remind_from columns stay (no
-- longer read or written) and are dropped in a later migration.

CREATE TABLE "student_categories" (
  "id"            SERIAL PRIMARY KEY,
  "code"          VARCHAR(40)  NOT NULL,
  "label"         VARCHAR(100) NOT NULL,
  "description"   VARCHAR(300),
  "tone"          VARCHAR(20)  NOT NULL DEFAULT 'slate',
  "display_order" INTEGER      NOT NULL DEFAULT 0,
  "is_active"     BOOLEAN      NOT NULL DEFAULT true,
  "created_at"    TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "student_categories_code_key" ON "student_categories"("code");

CREATE TABLE "student_category_assignments" (
  "id"          SERIAL PRIMARY KEY,
  "student_id"  INTEGER      NOT NULL,
  "category_id" INTEGER      NOT NULL,
  "reason"      VARCHAR(500),
  "until"       DATE,
  "remind_from" DATE,
  "created_at"  TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "student_category_assignments_student_id_fkey"
    FOREIGN KEY ("student_id") REFERENCES "students"("cc") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "student_category_assignments_category_id_fkey"
    FOREIGN KEY ("category_id") REFERENCES "student_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "uq_student_category_assignment" ON "student_category_assignments"("student_id", "category_id");
CREATE INDEX "idx_student_category_assignments_category" ON "student_category_assignments"("category_id");

-- The five categories that existed as columns, in the order the software showed them.
INSERT INTO "student_categories" ("code", "label", "description", "tone", "display_order") VALUES
  ('FEE_ENDOWMENT',     'Fee Endowment',                       'Everything waived',                               'amber',   10),
  ('FEE_ENDOWMENT_MTF', 'Fee Endowment (Monthly Tuition Fee)', 'Monthly Tuition Fee waived; other heads charged', 'orange',  20),
  ('COMPLEMENTARY',     'Complementary',                       'Everything waived',                               'emerald', 30),
  ('SEHM_E_SADAAT',     'Sehm-e-Sadaat',                       'Everything waived',                               'sky',     40),
  ('SEHM_E_IMAM',       'Sehm-e-Imam',                         'Everything waived',                               'violet',  50);

-- Copy every student's current categories across (switched-on flags only).
INSERT INTO "student_category_assignments" ("student_id", "category_id", "reason", "until", "remind_from")
SELECT s.cc, c.id, v.reason, v.until, v.remind_from
FROM "students" s
CROSS JOIN LATERAL (VALUES
  ('FEE_ENDOWMENT',     s.is_fee_endowment,     s.fee_endowment_reason,     s.fee_endowment_until,     s.fee_endowment_remind_from),
  ('FEE_ENDOWMENT_MTF', s.is_fee_endowment_mtf, s.fee_endowment_mtf_reason, s.fee_endowment_mtf_until, s.fee_endowment_mtf_remind_from),
  ('COMPLEMENTARY',     s.is_complementary,     s.complementary_reason,     s.complementary_until,     s.complementary_remind_from),
  ('SEHM_E_SADAAT',     s.is_sehm_e_sadaat,     s.sehm_e_sadaat_reason,     s.sehm_e_sadaat_until,     s.sehm_e_sadaat_remind_from),
  ('SEHM_E_IMAM',       s.is_sehm_e_imam,       s.sehm_e_imam_reason,       s.sehm_e_imam_until,       s.sehm_e_imam_remind_from)
) AS v(code, is_on, reason, until, remind_from)
JOIN "student_categories" c ON c.code = v.code
WHERE v.is_on = true
ON CONFLICT ("student_id", "category_id") DO NOTHING;

-- Prisma's @updatedAt sets the value itself; the default was only for the copy above.
ALTER TABLE "student_categories" ALTER COLUMN "updated_at" DROP DEFAULT;
ALTER TABLE "student_category_assignments" ALTER COLUMN "updated_at" DROP DEFAULT;
