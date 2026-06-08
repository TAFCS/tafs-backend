-- CreateTable
CREATE TABLE IF NOT EXISTS "staff_types" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(255),
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "staff_types_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "staff_types_code_key" ON "staff_types"("code");

-- AlterTable
ALTER TABLE "employee_profiles"
    ADD COLUMN IF NOT EXISTS "employee_code" VARCHAR(50),
    ADD COLUMN IF NOT EXISTS "full_name" VARCHAR(100),
    ADD COLUMN IF NOT EXISTS "father_name" VARCHAR(100),
    ADD COLUMN IF NOT EXISTS "mother_name" VARCHAR(100),
    ADD COLUMN IF NOT EXISTS "date_of_birth" DATE,
    ADD COLUMN IF NOT EXISTS "address" TEXT,
    ADD COLUMN IF NOT EXISTS "personal_phone" VARCHAR(20),
    ADD COLUMN IF NOT EXISTS "personal_email" VARCHAR(100),
    ADD COLUMN IF NOT EXISTS "job_title" VARCHAR(100),
    ADD COLUMN IF NOT EXISTS "job_description" TEXT,
    ADD COLUMN IF NOT EXISTS "notes" TEXT,
    ADD COLUMN IF NOT EXISTS "reporting_time" TIME(0),
    ADD COLUMN IF NOT EXISTS "leaving_time" TIME(0),
    ADD COLUMN IF NOT EXISTS "late_relaxation_minutes" INTEGER,
    ADD COLUMN IF NOT EXISTS "monthly_pay" DECIMAL(12,2),
    ADD COLUMN IF NOT EXISTS "staff_type_id" INTEGER,
    ADD COLUMN IF NOT EXISTS "campus_id" INTEGER,
    ADD COLUMN IF NOT EXISTS "days_per_week" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "employee_profiles_employee_code_key" ON "employee_profiles"("employee_code");

-- AddForeignKey
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_staff_type_id_fkey" FOREIGN KEY ("staff_type_id") REFERENCES "staff_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_campus_id_fkey" FOREIGN KEY ("campus_id") REFERENCES "campuses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE IF NOT EXISTS "employee_class_section_assignments" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "class_id" INTEGER NOT NULL,
    "section_id" INTEGER NOT NULL,

    CONSTRAINT "employee_class_section_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "employee_class_section_assignments_employee_id_class_id_se_key" ON "employee_class_section_assignments"("employee_id", "class_id", "section_id");

-- AddForeignKey
ALTER TABLE "employee_class_section_assignments" ADD CONSTRAINT "employee_class_section_assignments_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_class_section_assignments" ADD CONSTRAINT "employee_class_section_assignments_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_class_section_assignments" ADD CONSTRAINT "employee_class_section_assignments_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
