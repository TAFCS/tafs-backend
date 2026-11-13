-- Student document vault (Academics plan §5, TAFSD-498). Additive only.
-- Files live in private storage; rows hold the storage key, never a URL.
-- Versions are append-only: a replacement is a new row, nothing is deleted.

CREATE TABLE "student_document_types" (
  "id"                    SERIAL PRIMARY KEY,
  "code"                  VARCHAR(40)  NOT NULL,
  "name"                  VARCHAR(100) NOT NULL,
  "description"           VARCHAR(300),
  "owner"                 VARCHAR(10)  NOT NULL DEFAULT 'STUDENT',
  "origin"                VARCHAR(10)  NOT NULL DEFAULT 'PROVIDED',
  "allow_multiple"        BOOLEAN      NOT NULL DEFAULT false,
  "required_at_admission" BOOLEAN      NOT NULL DEFAULT false,
  "restricted"            BOOLEAN      NOT NULL DEFAULT false,
  "visible_to_parents"    BOOLEAN      NOT NULL DEFAULT false,
  "is_system"             BOOLEAN      NOT NULL DEFAULT false,
  "is_active"             BOOLEAN      NOT NULL DEFAULT true,
  "display_order"         INTEGER      NOT NULL DEFAULT 0,
  "created_at"            TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "student_document_types_owner_check"  CHECK ("owner"  IN ('STUDENT', 'GUARDIAN')),
  CONSTRAINT "student_document_types_origin_check" CHECK ("origin" IN ('PROVIDED', 'GENERATED'))
);
CREATE UNIQUE INDEX "student_document_types_code_key" ON "student_document_types"("code");

CREATE TABLE "student_documents" (
  "id"             SERIAL PRIMARY KEY,
  "type_id"        INTEGER      NOT NULL,
  "student_id"     INTEGER,
  "guardian_id"    INTEGER,
  "title"          VARCHAR(150),
  "academic_year"  VARCHAR(20),
  "source_ref"     VARCHAR(80),
  "archived_at"    TIMESTAMP(6),
  "archived_by"    VARCHAR(255),
  "archive_reason" VARCHAR(500),
  "created_by"     VARCHAR(255) NOT NULL,
  "created_at"     TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "student_documents_one_owner_check"
    CHECK (("student_id" IS NOT NULL) <> ("guardian_id" IS NOT NULL)),
  CONSTRAINT "student_documents_type_id_fkey"
    FOREIGN KEY ("type_id") REFERENCES "student_document_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "student_documents_student_id_fkey"
    FOREIGN KEY ("student_id") REFERENCES "students"("cc") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "student_documents_guardian_id_fkey"
    FOREIGN KEY ("guardian_id") REFERENCES "guardians"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "student_documents_type_id_source_ref_key" ON "student_documents"("type_id", "source_ref");
CREATE INDEX "student_documents_student_id_idx"  ON "student_documents"("student_id");
CREATE INDEX "student_documents_guardian_id_idx" ON "student_documents"("guardian_id");

CREATE TABLE "student_document_versions" (
  "id"                SERIAL PRIMARY KEY,
  "document_id"       INTEGER      NOT NULL,
  "version_no"        INTEGER      NOT NULL,
  "storage_key"       TEXT         NOT NULL,
  "mime_type"         VARCHAR(100) NOT NULL,
  "size_bytes"        INTEGER      NOT NULL,
  "sha256"            VARCHAR(64)  NOT NULL,
  "original_filename" VARCHAR(255),
  "page_count"        INTEGER,
  "channel"           VARCHAR(20)  NOT NULL DEFAULT 'DESK_UPLOAD',
  "note"              VARCHAR(500),
  "uploaded_by"       VARCHAR(255) NOT NULL,
  "uploaded_at"       TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "student_document_versions_document_id_fkey"
    FOREIGN KEY ("document_id") REFERENCES "student_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "student_document_versions_document_id_version_no_key"
  ON "student_document_versions"("document_id", "version_no");

-- Starting list from the plan. Required-at-admission is the obvious pair; the
-- school can change every flag in School Setup.
INSERT INTO "student_document_types"
  ("code", "name", "description", "owner", "origin", "allow_multiple", "required_at_admission", "restricted", "is_system", "display_order") VALUES
  ('B_FORM',              'B-Form / CNIC',                        NULL,                                          'STUDENT',  'PROVIDED',  false, true,  false, false, 10),
  ('BIRTH_CERTIFICATE',   'Birth certificate',                    NULL,                                          'STUDENT',  'PROVIDED',  false, true,  false, false, 20),
  ('PASSPORT',            'Passport',                             'Proof for overseas students',                 'STUDENT',  'PROVIDED',  false, false, false, false, 30),
  ('PREVIOUS_SCHOOL_LC',  'Previous school leaving certificate',  NULL,                                          'STUDENT',  'PROVIDED',  false, false, false, false, 40),
  ('PREVIOUS_RESULTS',    'Previous school results',              NULL,                                          'STUDENT',  'PROVIDED',  true,  false, false, false, 50),
  ('REPORT_CARD',         'Report card',                          NULL,                                          'STUDENT',  'PROVIDED',  true,  false, false, false, 60),
  ('MEDICAL_RECORD',      'Medical record',                       NULL,                                          'STUDENT',  'PROVIDED',  true,  false, true,  false, 70),
  ('SCANNED_FORM',        'Scanned form',                         'Registration form and other paper forms',     'STUDENT',  'PROVIDED',  true,  false, false, false, 80),
  ('OTHER',               'Other',                                NULL,                                          'STUDENT',  'PROVIDED',  true,  false, false, false, 90),
  ('GUARDIAN_CNIC',       'CNIC',                                 'Front and back',                              'GUARDIAN', 'PROVIDED',  false, true,  false, false, 110),
  ('GUARDIAN_PASSPORT',   'Passport',                             NULL,                                          'GUARDIAN', 'PROVIDED',  false, false, false, false, 120),
  ('ADMIT_CARD',          'Admit card',                           NULL,                                          'STUDENT',  'GENERATED', true,  false, false, true,  210),
  ('STATEMENT_OF_ENTRY',  'Statement of entry',                   NULL,                                          'STUDENT',  'GENERATED', true,  false, false, true,  220),
  ('STATEMENT_OF_MARKS',  'Statement of marks',                   NULL,                                          'STUDENT',  'GENERATED', true,  false, false, true,  230),
  ('RESULT_CERTIFICATE',  'Result certificate',                   NULL,                                          'STUDENT',  'GENERATED', true,  false, false, true,  240),
  ('OFFER_LETTER',        'Offer letter',                         NULL,                                          'STUDENT',  'GENERATED', true,  false, false, true,  250),
  ('ADMISSION_FORM',      'Admission form (Form 2)',              NULL,                                          'STUDENT',  'GENERATED', true,  false, false, true,  260),
  ('ADMISSION_ORDER',     'Admission order',                      NULL,                                          'STUDENT',  'GENERATED', true,  false, false, true,  270),
  ('TRANSFER_ORDER',      'Transfer order',                       NULL,                                          'STUDENT',  'GENERATED', true,  false, false, true,  280),
  ('LEAVING_CERTIFICATE', 'School leaving certificate',           'Issued by TAFS',                              'STUDENT',  'GENERATED', true,  false, false, true,  290);
