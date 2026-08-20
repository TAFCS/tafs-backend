-- Per (campus, class) bell schedule, replacing the single global
-- timetable_blocks template. Different classes/segments run different
-- period lengths and break windows, so block times are no longer
-- one-size-fits-all. block_number lines up with timetable_slots.block_number
-- for the same (campus, class). A row with is_break=true has no
-- corresponding slots -- it's a display-only divider (e.g. "BREAK 10:30-11:00").
CREATE TABLE "class_timetable_periods" (
    "id" SERIAL NOT NULL,
    "campus_id" INTEGER NOT NULL,
    "class_id" INTEGER NOT NULL,
    "block_number" INTEGER NOT NULL,
    "start_time" TIME(0) NOT NULL,
    "end_time" TIME(0) NOT NULL,
    "is_break" BOOLEAN NOT NULL DEFAULT false,
    "label" VARCHAR(20),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "class_timetable_periods_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "class_timetable_periods_scope_key" ON "class_timetable_periods"("campus_id", "class_id", "block_number");
CREATE INDEX "class_timetable_periods_campus_id_class_id_idx" ON "class_timetable_periods"("campus_id", "class_id");

ALTER TABLE "class_timetable_periods" ADD CONSTRAINT "class_timetable_periods_campus_id_fkey" FOREIGN KEY ("campus_id") REFERENCES "campuses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "class_timetable_periods" ADD CONSTRAINT "class_timetable_periods_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
