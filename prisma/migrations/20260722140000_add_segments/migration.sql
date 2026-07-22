-- CreateTable
CREATE TABLE "segments" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(30) NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "segments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "segments_code_key" ON "segments"("code");

-- AlterTable
ALTER TABLE "classes" ADD COLUMN "segment_id" INTEGER;

-- AddForeignKey
ALTER TABLE "classes" ADD CONSTRAINT "classes_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "segments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed the six segments
INSERT INTO "segments" ("code", "name", "display_order") VALUES
    ('PRE_PRIMARY', 'Pre-Primary', 1),
    ('JUNIOR_CAMBRIDGE', 'Junior Cambridge', 2),
    ('SENIOR_CAMBRIDGE', 'Senior Cambridge', 3),
    ('OLEVELS_CAMBRIDGE', 'O-Levels Cambridge', 4),
    ('ALEVELS_CAMBRIDGE', 'A-Levels Cambridge', 5),
    ('SECONDARY', 'Secondary', 6);

-- Map existing classes (ids per the seeded academic setup) to their segment
UPDATE "classes" SET "segment_id" = (SELECT "id" FROM "segments" WHERE "code" = 'PRE_PRIMARY')
    WHERE "class_code" IN ('PN', 'NUR', 'KG');

UPDATE "classes" SET "segment_id" = (SELECT "id" FROM "segments" WHERE "code" = 'JUNIOR_CAMBRIDGE')
    WHERE "class_code" IN ('JRI', 'JRII', 'JRIII', 'JRIV', 'JRV');

UPDATE "classes" SET "segment_id" = (SELECT "id" FROM "segments" WHERE "code" = 'SENIOR_CAMBRIDGE')
    WHERE "class_code" IN ('SRI', 'SRII', 'SRIII');

UPDATE "classes" SET "segment_id" = (SELECT "id" FROM "segments" WHERE "code" = 'OLEVELS_CAMBRIDGE')
    WHERE "class_code" IN ('OI', 'OII', 'OIII');

UPDATE "classes" SET "segment_id" = (SELECT "id" FROM "segments" WHERE "code" = 'ALEVELS_CAMBRIDGE')
    WHERE "class_code" IN ('AS', 'A2');

UPDATE "classes" SET "segment_id" = (SELECT "id" FROM "segments" WHERE "code" = 'SECONDARY')
    WHERE "class_code" IN ('VI', 'VII', 'VIII', 'IX', 'X');
