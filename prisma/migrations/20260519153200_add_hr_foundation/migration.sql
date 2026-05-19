-- CreateTable
CREATE TABLE "departments" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(255),

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "designations" (
    "id" SERIAL NOT NULL,
    "department_id" INTEGER NOT NULL,
    "title" VARCHAR(100) NOT NULL,
    "description" VARCHAR(255),

    CONSTRAINT "designations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_profiles" (
    "id" SERIAL NOT NULL,
    "user_id" TEXT,
    "cnic" VARCHAR(20),
    "join_date" DATE,
    "employment_type" VARCHAR(50),
    "department_id" INTEGER,
    "designation_id" INTEGER,
    "reporting_manager_id" INTEGER,

    CONSTRAINT "employee_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "academic_calendar_days" (
    "id" SERIAL NOT NULL,
    "campus_id" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "day_type" VARCHAR(20) NOT NULL,
    "description" VARCHAR(255),

    CONSTRAINT "academic_calendar_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "class_attendance_modes" (
    "id" SERIAL NOT NULL,
    "class_id" INTEGER NOT NULL,
    "mode" VARCHAR(50) NOT NULL DEFAULT 'BIOMETRIC_DAILY',

    CONSTRAINT "class_attendance_modes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_policy_sets" (
    "id" SERIAL NOT NULL,
    "campus_id" INTEGER NOT NULL,
    "academic_year" VARCHAR(10) NOT NULL,
    "effective_from" DATE NOT NULL,
    "description" VARCHAR(255),

    CONSTRAINT "hr_policy_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_policy_rules" (
    "id" SERIAL NOT NULL,
    "policy_set_id" INTEGER NOT NULL,
    "rule_type" VARCHAR(100) NOT NULL,
    "value_json" JSONB NOT NULL DEFAULT '{}',
    "applies_to" VARCHAR(50),
    "description" VARCHAR(255),

    CONSTRAINT "hr_policy_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_types" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(255),
    "is_paid" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "leave_types_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "employee_profiles_user_id_key" ON "employee_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_profiles_cnic_key" ON "employee_profiles"("cnic");

-- CreateIndex
CREATE UNIQUE INDEX "academic_calendar_days_campus_id_date_key" ON "academic_calendar_days"("campus_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "class_attendance_modes_class_id_key" ON "class_attendance_modes"("class_id");

-- CreateIndex
CREATE UNIQUE INDEX "hr_policy_rules_policy_set_id_rule_type_key" ON "hr_policy_rules"("policy_set_id", "rule_type");

-- AddForeignKey
ALTER TABLE "designations" ADD CONSTRAINT "designations_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_designation_id_fkey" FOREIGN KEY ("designation_id") REFERENCES "designations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_reporting_manager_id_fkey" FOREIGN KEY ("reporting_manager_id") REFERENCES "employee_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academic_calendar_days" ADD CONSTRAINT "academic_calendar_days_campus_id_fkey" FOREIGN KEY ("campus_id") REFERENCES "campuses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_attendance_modes" ADD CONSTRAINT "class_attendance_modes_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_policy_sets" ADD CONSTRAINT "hr_policy_sets_campus_id_fkey" FOREIGN KEY ("campus_id") REFERENCES "campuses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_policy_rules" ADD CONSTRAINT "hr_policy_rules_policy_set_id_fkey" FOREIGN KEY ("policy_set_id") REFERENCES "hr_policy_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
