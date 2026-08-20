-- Dedicated School Leaving Certificate (SLC) serial, independent of CC / GR.
ALTER TABLE "students" ADD COLUMN "slc_number" INTEGER;

CREATE UNIQUE INDEX "students_slc_number_key" ON "students"("slc_number");

-- Seed tracker: last issued SLC is 250, so the next allocation will be 251.
INSERT INTO "app_config" ("key", "value", "description", "updated_at", "updated_by")
VALUES (
  'slc_last_number',
  '250',
  'Last issued School Leaving Certificate (SLC) number. Next issued = this + 1.',
  NOW(),
  'SEED'
)
ON CONFLICT ("key") DO NOTHING;
