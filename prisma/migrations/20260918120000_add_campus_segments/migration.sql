-- Which segments a campus actually runs.
-- Until now this was only inferable from campus_classes, which is wrong in both
-- directions: a campus can carry a stray class from a segment it does not run,
-- and a segment a campus runs may have no class rows yet. Employee segment is
-- an HR fact, not a class fact, so it needs its own mapping.
CREATE TABLE "campus_segments" (
    "id" SERIAL NOT NULL,
    "campus_id" INTEGER NOT NULL,
    "segment_id" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "campus_segments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "campus_segments_unique" ON "campus_segments"("campus_id", "segment_id");
CREATE INDEX "idx_campus_segments_campus" ON "campus_segments"("campus_id");
CREATE INDEX "idx_campus_segments_segment" ON "campus_segments"("segment_id");

ALTER TABLE "campus_segments" ADD CONSTRAINT "campus_segments_campus_id_fkey"
    FOREIGN KEY ("campus_id") REFERENCES "campuses"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "campus_segments" ADD CONSTRAINT "campus_segments_segment_id_fkey"
    FOREIGN KEY ("segment_id") REFERENCES "segments"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- Seed the rules as they stand today. Matched on codes, not ids, so this is
-- safe to replay on any environment.
-- Gulistan-e-Johar runs every segment.
INSERT INTO "campus_segments" ("campus_id", "segment_id")
SELECT c.id, s.id
FROM "campuses" c
CROSS JOIN "segments" s
WHERE c.campus_code = 'GEJ'
ON CONFLICT ("campus_id", "segment_id") DO NOTHING;

-- Kaneez Fatima and North Nazimabad run Pre-Primary and Junior Cambridge only.
INSERT INTO "campus_segments" ("campus_id", "segment_id")
SELECT c.id, s.id
FROM "campuses" c
JOIN "segments" s ON s.code IN ('PRE_PRIMARY', 'JUNIOR_CAMBRIDGE')
WHERE c.campus_code IN ('KNF', 'NNZ')
ON CONFLICT ("campus_id", "segment_id") DO NOTHING;
