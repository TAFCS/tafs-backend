-- AlterTable
ALTER TABLE "vouchers" ADD COLUMN     "reprint_fee_charge" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reprint_fee_amount" DECIMAL(12,2);
