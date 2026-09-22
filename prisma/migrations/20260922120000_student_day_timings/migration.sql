-- Student day timings: a campus+class pairing gets a start, an end, and an
-- internal "intermediate" time that decides what a punch means.
--
-- expected_check_in is reused as the START time — it already is "the time the
-- kid is expected in" and already drives LATE marking. Adding a second
-- start-ish column would give us two sources of truth that drift.

-- 1. The two new times. Nullable on purpose: every existing row predates them,
--    and a NULL intermediate_time means "no intermediate rule configured",
--    which the punch resolver reads as "keep the old strict IN/OUT parity".
ALTER TABLE "class_check_in_schedules"
    ADD COLUMN IF NOT EXISTS "end_time"          TIME(0),
    ADD COLUMN IF NOT EXISTS "intermediate_time" TIME(0);

-- 2. The pairing is campus+class, not class.
--
-- Classes are shared across campuses via campus_classes, so the old
-- (class_id, effective_from) key meant Class VI at North Nazimabad and
-- Class VI at Gulistan-e-Johar could not both hold a schedule effective the
-- same date — the second insert failed with a unique violation. Widening the
-- key can never conflict with existing data.
--
-- Prisma has emitted this as a plain unique index in some versions and as a
-- table constraint in others, and this table predates the migrations folder,
-- so drop whichever shape is actually present.
ALTER TABLE "class_check_in_schedules"
    DROP CONSTRAINT IF EXISTS "class_check_in_schedules_class_id_effective_from_key";
DROP INDEX IF EXISTS "class_check_in_schedules_class_id_effective_from_key";

CREATE UNIQUE INDEX IF NOT EXISTS "class_check_in_schedules_campus_class_effective_key"
    ON "class_check_in_schedules"("campus_id", "class_id", "effective_from");

-- 3. What we told parents, and when.
--
-- Neither existing notification table fits: attendance_notifications is
-- per-scan (it requires a direction and a scan_time) and calendar_notifications
-- is per-day-per-student. This is per-announcement, fanned out to a whole
-- campus+class, and we need to be able to show an admin what was last sent.
--
-- start_time / end_time are copied in rather than joined: this is a record of
-- what parents were actually told, so a later edit to the schedule must not
-- rewrite history.
CREATE TABLE "class_timing_notifications" (
    "id"              SERIAL       NOT NULL,
    "schedule_id"     INTEGER,
    "campus_id"       INTEGER      NOT NULL,
    "class_id"        INTEGER      NOT NULL,
    "start_time"      TIME(0)      NOT NULL,
    "end_time"        TIME(0),
    "effective_from"  DATE         NOT NULL,
    "students_matched" INTEGER     NOT NULL DEFAULT 0,
    "families_notified" INTEGER    NOT NULL DEFAULT 0,
    "title"           VARCHAR(255) NOT NULL,
    "body"            TEXT         NOT NULL,
    "created_by"      TEXT,
    "created_at"      TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "class_timing_notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_class_timing_notifications_pairing"
    ON "class_timing_notifications"("campus_id", "class_id", "created_at" DESC);

ALTER TABLE "class_timing_notifications" ADD CONSTRAINT "class_timing_notifications_schedule_id_fkey"
    FOREIGN KEY ("schedule_id") REFERENCES "class_check_in_schedules"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE "class_timing_notifications" ADD CONSTRAINT "class_timing_notifications_campus_id_fkey"
    FOREIGN KEY ("campus_id") REFERENCES "campuses"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "class_timing_notifications" ADD CONSTRAINT "class_timing_notifications_class_id_fkey"
    FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
