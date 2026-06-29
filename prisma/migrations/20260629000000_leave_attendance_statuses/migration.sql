-- Add specific leave type statuses to StaffAttendanceStatus enum
ALTER TYPE "StaffAttendanceStatus" ADD VALUE IF NOT EXISTS 'SICK_LEAVE';
ALTER TYPE "StaffAttendanceStatus" ADD VALUE IF NOT EXISTS 'CASUAL_LEAVE';
ALTER TYPE "StaffAttendanceStatus" ADD VALUE IF NOT EXISTS 'ANNUAL_LEAVE';
