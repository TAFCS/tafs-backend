-- Local throwaway seed for the TAFSD-531 end-to-end check. Synthetic data only.
-- Run once against a fresh local database after the backend has booted on it
-- (boot projects the tiles the grants below point at). e2e.mjs sets passwords.
INSERT INTO campuses (id, campus_code, campus_name) VALUES (1,'NRTH','North Test Campus'),(2,'STH','South Test Campus');
INSERT INTO classes (id, description, class_code, academic_system) VALUES (1,'Class VI','VI','NATIONAL'),(2,'Class VII','VII','NATIONAL');
INSERT INTO sections (id, description) VALUES (1,'A'),(2,'B');
INSERT INTO students (cc, full_name, status, campus_id, class_id, section_id, gr_number) VALUES
 (9001,'Ali Raza North','ENROLLED',1,1,1,'N-1'),
 (9002,'Ali Khan North','ENROLLED',1,1,1,'N-2'),
 (9003,'Ali Haider South','ENROLLED',2,2,2,'S-1'),
 (9004,'Sara South','ENROLLED',2,2,2,'S-2');
INSERT INTO users (id, username, password_hash, full_name, role, campus_id, is_active, updated_at) VALUES
 ('00000000-0000-4000-8000-000000000001','local.admin','set-by-e2e','Local Admin','SUPER_ADMIN',NULL,true,now()),
 ('00000000-0000-4000-8000-000000000002','north.registrar','set-by-e2e','North Registrar','EMPLOYEE',1,true,now()),
 ('00000000-0000-4000-8000-000000000003','south.accounts','set-by-e2e','South Accounts','EMPLOYEE',2,true,now()),
 ('00000000-0000-4000-8000-000000000004','no.assistant','set-by-e2e','No Assistant','EMPLOYEE',1,true,now());
-- north.registrar: Student Directory, limited to campus 1.
-- south.accounts: Vouchers, Single Voucher, Financial Reports, limited to campus 2.
-- no.assistant: Student Directory but NOT the AI Assistant tile.
INSERT INTO user_tile_grants (user_id, tile_id, allow, granted_by) VALUES
 ('00000000-0000-4000-8000-000000000002','system.ai_assistant',true,'00000000-0000-4000-8000-000000000001'),
 ('00000000-0000-4000-8000-000000000002','student.directory',true,'00000000-0000-4000-8000-000000000001'),
 ('00000000-0000-4000-8000-000000000003','system.ai_assistant',true,'00000000-0000-4000-8000-000000000001'),
 ('00000000-0000-4000-8000-000000000003','finance.vouchers',true,'00000000-0000-4000-8000-000000000001'),
 ('00000000-0000-4000-8000-000000000003','finance.single_voucher',true,'00000000-0000-4000-8000-000000000001'),
 ('00000000-0000-4000-8000-000000000003','finance.financial_reports',true,'00000000-0000-4000-8000-000000000001'),
 ('00000000-0000-4000-8000-000000000004','student.directory',true,'00000000-0000-4000-8000-000000000001');
INSERT INTO user_scope_entries (user_id, dimension, ref_id) VALUES
 ('00000000-0000-4000-8000-000000000002','CAMPUS',1),
 ('00000000-0000-4000-8000-000000000003','CAMPUS',2);
SELECT setval(pg_get_serial_sequence('students','cc'), 9100);
