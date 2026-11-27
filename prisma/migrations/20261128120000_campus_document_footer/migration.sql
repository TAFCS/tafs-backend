-- TAFSD-603: a footer per campus for its official documents (statements of entry, admit cards,
-- leaving certificates), one array entry a line. Empty keeps each document's own footer.
ALTER TABLE "campuses" ADD COLUMN "document_footer" TEXT[] DEFAULT ARRAY[]::TEXT[];
