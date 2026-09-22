-- Day-of-week overrides for a campus+class pairing's school-day timings.
--
-- The base class_check_in_schedules row is the ordinary day. Friday runs an
-- hour earlier for every class at TAFS, and there is no reason to assume it
-- stays the only exception, so the shape is a general per-weekday override
-- rather than a friday_* column.
--
-- A day row REPLACES the base for that weekday, wholesale — it is not a
-- field-by-field merge. That keeps "inherit" and "deliberately cleared"
-- from being the same value: no row means inherit, a row means these are the
-- times, and a NULL end_time on a day row means that day genuinely has no end
-- time recorded.
CREATE TABLE "class_check_in_schedule_days" (
    "id"                SERIAL       NOT NULL,
    "schedule_id"       INTEGER      NOT NULL,
    -- 0 = Sunday … 6 = Saturday, matching JS getUTCDay() so the resolver can
    -- index straight off the attendance date with no translation table.
    "day_of_week"       SMALLINT     NOT NULL,
    "expected_check_in" TIME(0)      NOT NULL,
    "end_time"          TIME(0),
    "intermediate_time" TIME(0),
    "created_at"        TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "class_check_in_schedule_days_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "class_check_in_schedule_days_dow_range" CHECK ("day_of_week" BETWEEN 0 AND 6)
);

CREATE UNIQUE INDEX "class_check_in_schedule_days_schedule_dow_key"
    ON "class_check_in_schedule_days"("schedule_id", "day_of_week");

ALTER TABLE "class_check_in_schedule_days" ADD CONSTRAINT "class_check_in_schedule_days_schedule_id_fkey"
    FOREIGN KEY ("schedule_id") REFERENCES "class_check_in_schedules"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
