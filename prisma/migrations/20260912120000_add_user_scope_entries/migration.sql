-- Universal per-user data scope ("can edit / touch").
--
-- Replaces the two ad-hoc scoping fields that exist today:
--   * users.campus_id        -- a single nullable campus, checked by a
--                               `private assertCampusAccess` method that is
--                               copy-pasted into 12 separate services
--   * users.allowed_class_ids -- an Int[] read in only 5 places
-- Segments and sections had no scoping at all.
--
-- Semantics: a dimension with NO rows for a user is UNRESTRICTED on that
-- dimension. Dimensions AND together -- a record must match every dimension
-- the user has rows for. SUPER_ADMIN bypasses the whole mechanism.
--
-- Normalized rather than array columns so adding a dimension is an enum value,
-- not a migration over every row.

CREATE TYPE "ScopeDimension" AS ENUM (
  'CAMPUS',
  'SEGMENT',
  'CLASS',
  'SECTION',
  'DEPARTMENT',
  'STAFF_CATEGORY'
);

CREATE TABLE "user_scope_entries" (
  "user_id"    TEXT NOT NULL,
  "dimension"  "ScopeDimension" NOT NULL,
  "ref_id"     INTEGER NOT NULL,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "user_scope_entries_pkey" PRIMARY KEY ("user_id", "dimension", "ref_id")
);

CREATE INDEX "user_scope_entries_dimension_ref_id_idx"
  ON "user_scope_entries" ("dimension", "ref_id");

ALTER TABLE "user_scope_entries"
  ADD CONSTRAINT "user_scope_entries_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill from the fields this replaces, so nobody's effective scope changes
-- on deploy. users.campus_id NULL stays NULL -> no rows -> unrestricted, which
-- is exactly what a null campus_id meant before.
INSERT INTO "user_scope_entries" ("user_id", "dimension", "ref_id")
SELECT "id", 'CAMPUS', "campus_id"
FROM "users"
WHERE "campus_id" IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO "user_scope_entries" ("user_id", "dimension", "ref_id")
SELECT u."id", 'CLASS', c
FROM "users" u, UNNEST(u."allowed_class_ids") AS c
WHERE u."allowed_class_ids" IS NOT NULL
  AND array_length(u."allowed_class_ids", 1) > 0
ON CONFLICT DO NOTHING;
