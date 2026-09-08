-- CreateTable
CREATE TABLE "employee_previous_employers" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "employer_name" VARCHAR(100),
    "location" VARCHAR(100),
    "job_title" VARCHAR(100),
    "employed_from" VARCHAR(20),
    "employed_to" VARCHAR(20),
    "reason_for_leaving" TEXT,

    CONSTRAINT "employee_previous_employers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_previous_employers_employee_id_idx" ON "employee_previous_employers"("employee_id");

-- AddForeignKey
ALTER TABLE "employee_previous_employers" ADD CONSTRAINT "employee_previous_employers_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
