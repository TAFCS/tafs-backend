-- Create unconfirmed_admissions table
CREATE TABLE IF NOT EXISTS "unconfirmed_admissions" (
    "id" SERIAL PRIMARY KEY,
    "full_name" VARCHAR(200) NOT NULL,
    "date_of_birth" DATE NOT NULL,
    "gender" VARCHAR(20) NOT NULL,
    "address" TEXT,
    "campus_id" INTEGER REFERENCES "campuses"("id") ON DELETE SET NULL,
    "photograph_url" TEXT,
    "deposit_amount" DECIMAL(10, 2) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(255),
    "guardian_name" VARCHAR(200),
    "guardian_relation" VARCHAR(100),
    "guardian_cnic" VARCHAR(15)
);
