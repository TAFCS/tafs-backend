-- TAFSD-448: staff can move a ticket to another lane, topic or desk.
-- Additive only: one new event type.
ALTER TYPE "TicketEventType" ADD VALUE IF NOT EXISTS 'MOVED';
