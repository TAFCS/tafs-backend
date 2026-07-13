-- Add SUPPORT_STAFF category for non-teaching support roles (peons, caretakers)
-- that don't fit any existing StaffCategory value.
ALTER TYPE "StaffCategory" ADD VALUE IF NOT EXISTS 'SUPPORT_STAFF';
