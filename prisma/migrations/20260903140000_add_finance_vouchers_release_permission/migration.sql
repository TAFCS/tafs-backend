-- Pending Release tile (finance.vouchers.release) was added to seed-permissions.ts
-- after existing DBs were seeded. AccessSync requires the row at boot.
INSERT INTO "permissions" ("key", "module", "description")
SELECT 'finance.vouchers.release', 'Finance Operations', 'Release held vouchers to parents'
WHERE NOT EXISTS (SELECT 1 FROM "permissions" WHERE "key" = 'finance.vouchers.release');
