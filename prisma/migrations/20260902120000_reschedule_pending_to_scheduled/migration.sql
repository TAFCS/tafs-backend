-- Rename PENDING → SCHEDULED for class/staff lesson reschedule workflow
ALTER TYPE "ClassSessionRescheduleStatus" RENAME VALUE 'PENDING' TO 'SCHEDULED';

ALTER TABLE "class_session_reschedules" ALTER COLUMN "status" SET DEFAULT 'SCHEDULED';
ALTER TABLE "staff_lesson_reschedules" ALTER COLUMN "status" SET DEFAULT 'SCHEDULED';

-- Cancel orphaned scheduled rows whose makeup session was SKIPPED
UPDATE class_session_reschedules csr
SET status = 'CANCELLED', makeup_roll_session_id = NULL
WHERE csr.status = 'SCHEDULED'
  AND csr.makeup_roll_session_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM attendance_roll_sessions ars
    WHERE ars.id = csr.makeup_roll_session_id
      AND ars.status = 'SKIPPED'
  );
