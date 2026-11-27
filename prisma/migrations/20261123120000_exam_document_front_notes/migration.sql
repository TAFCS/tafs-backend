-- TAFSD-555: the front-of-document note on statements of entry and admit cards,
-- set per schedule (and per preset), separate from the schedule sheet's notes.
ALTER TABLE "exam_schedules" ADD COLUMN "document_notes" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "exam_schedule_presets" ADD COLUMN "document_notes" TEXT[] DEFAULT ARRAY[]::TEXT[];
