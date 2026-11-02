-- TAFSD-455: three more fee benefit categories, and a reminder date for each.
ALTER TABLE "students"
  ADD COLUMN "is_fee_endowment_mtf"          BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "fee_endowment_mtf_reason"      VARCHAR(500),
  ADD COLUMN "fee_endowment_mtf_until"       DATE,
  ADD COLUMN "is_sehm_e_sadaat"              BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "sehm_e_sadaat_reason"          VARCHAR(500),
  ADD COLUMN "sehm_e_sadaat_until"           DATE,
  ADD COLUMN "is_sehm_e_imam"                BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "sehm_e_imam_reason"            VARCHAR(500),
  ADD COLUMN "sehm_e_imam_until"             DATE,
  ADD COLUMN "fee_endowment_remind_from"     DATE,
  ADD COLUMN "complementary_remind_from"     DATE,
  ADD COLUMN "fee_endowment_mtf_remind_from" DATE,
  ADD COLUMN "sehm_e_sadaat_remind_from"     DATE,
  ADD COLUMN "sehm_e_imam_remind_from"       DATE;
