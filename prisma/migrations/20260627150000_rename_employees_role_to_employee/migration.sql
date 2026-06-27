-- Rename payroll self-service login role: EMPLOYEES -> EMPLOYEE
ALTER TYPE "StaffRole" RENAME VALUE 'EMPLOYEES' TO 'EMPLOYEE';
