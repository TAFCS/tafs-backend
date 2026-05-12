-- Migration: Add Meezan bank fields to deposits
-- Date: 2026-05-12
--
-- Stores bank_code, bank_name, and date_of_return sent by Meezan Bank
-- in the bill-payment webhook. All nullable so non-Meezan deposits are unaffected.

ALTER TABLE public.deposits
  ADD COLUMN IF NOT EXISTS bank_code      VARCHAR(20),
  ADD COLUMN IF NOT EXISTS bank_name      VARCHAR(100),
  ADD COLUMN IF NOT EXISTS date_of_return DATE;
