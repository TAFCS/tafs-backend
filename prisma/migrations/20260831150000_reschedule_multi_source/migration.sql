-- DropIndex
DROP INDEX IF EXISTS "class_session_reschedules_makeup_roll_session_id_key";

-- CreateIndex
CREATE INDEX "class_session_reschedules_makeup_roll_session_id_idx" ON "class_session_reschedules"("makeup_roll_session_id");
