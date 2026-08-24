-- CreateTable
CREATE TABLE "payroll_statutory_rules" (
    "id" SERIAL NOT NULL,
    "rule_type" VARCHAR(50) NOT NULL,
    "effective_from" DATE NOT NULL,
    "value_json" JSONB NOT NULL DEFAULT '{}',
    "description" VARCHAR(255),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "payroll_statutory_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payroll_statutory_rules_rule_type_idx" ON "payroll_statutory_rules"("rule_type");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_statutory_rules_rule_type_effective_from_key" ON "payroll_statutory_rules"("rule_type", "effective_from");
