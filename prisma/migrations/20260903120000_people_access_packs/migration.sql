-- Access tiles / packs (additive layer on top of role_permissions)
CREATE TABLE "access_tiles" (
    "id" VARCHAR(80) NOT NULL,
    "module" VARCHAR(50) NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "description" VARCHAR(255) NOT NULL,
    "href" VARCHAR(255) NOT NULL,
    "group" VARCHAR(50),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "access_tiles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "access_tile_capabilities" (
    "tile_id" VARCHAR(80) NOT NULL,
    "permission_id" INTEGER NOT NULL,

    CONSTRAINT "access_tile_capabilities_pkey" PRIMARY KEY ("tile_id","permission_id")
);

CREATE TABLE "access_packs" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(255),
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_packs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "access_packs_name_key" ON "access_packs"("name");

CREATE TABLE "access_pack_tiles" (
    "pack_id" TEXT NOT NULL,
    "tile_id" VARCHAR(80) NOT NULL,

    CONSTRAINT "access_pack_tiles_pkey" PRIMARY KEY ("pack_id","tile_id")
);

CREATE TABLE "user_access_packs" (
    "user_id" TEXT NOT NULL,
    "pack_id" TEXT NOT NULL,
    "assigned_by" TEXT NOT NULL,
    "assigned_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_access_packs_pkey" PRIMARY KEY ("user_id","pack_id")
);

CREATE TABLE "user_tile_grants" (
    "user_id" TEXT NOT NULL,
    "tile_id" VARCHAR(80) NOT NULL,
    "allow" BOOLEAN NOT NULL,
    "granted_by" TEXT NOT NULL,
    "granted_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" VARCHAR(255),

    CONSTRAINT "user_tile_grants_pkey" PRIMARY KEY ("user_id","tile_id")
);

ALTER TABLE "access_tile_capabilities"
    ADD CONSTRAINT "access_tile_capabilities_tile_id_fkey"
    FOREIGN KEY ("tile_id") REFERENCES "access_tiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "access_tile_capabilities"
    ADD CONSTRAINT "access_tile_capabilities_permission_id_fkey"
    FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "access_pack_tiles"
    ADD CONSTRAINT "access_pack_tiles_pack_id_fkey"
    FOREIGN KEY ("pack_id") REFERENCES "access_packs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "access_pack_tiles"
    ADD CONSTRAINT "access_pack_tiles_tile_id_fkey"
    FOREIGN KEY ("tile_id") REFERENCES "access_tiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_access_packs"
    ADD CONSTRAINT "user_access_packs_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_access_packs"
    ADD CONSTRAINT "user_access_packs_pack_id_fkey"
    FOREIGN KEY ("pack_id") REFERENCES "access_packs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_access_packs"
    ADD CONSTRAINT "user_access_packs_assigned_by_fkey"
    FOREIGN KEY ("assigned_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "user_tile_grants"
    ADD CONSTRAINT "user_tile_grants_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_tile_grants"
    ADD CONSTRAINT "user_tile_grants_tile_id_fkey"
    FOREIGN KEY ("tile_id") REFERENCES "access_tiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_tile_grants"
    ADD CONSTRAINT "user_tile_grants_granted_by_fkey"
    FOREIGN KEY ("granted_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "access_tile_capabilities_permission_id_idx" ON "access_tile_capabilities"("permission_id");
CREATE INDEX "access_pack_tiles_tile_id_idx" ON "access_pack_tiles"("tile_id");
CREATE INDEX "user_access_packs_pack_id_idx" ON "user_access_packs"("pack_id");
CREATE INDEX "user_tile_grants_tile_id_idx" ON "user_tile_grants"("tile_id");

-- Payroll opt-out flag. Backfill: on payroll iff a monthly pay is set.
ALTER TABLE "employee_profiles" ADD COLUMN "payroll_enabled" BOOLEAN NOT NULL DEFAULT true;
UPDATE "employee_profiles" SET "payroll_enabled" = ("monthly_pay" IS NOT NULL);

-- Keys referenced by the tile manifest but previously missing from the seed.
INSERT INTO "permissions" ("key", "module", "description")
SELECT 'system.backups.view', 'System Administration', 'View database backups'
WHERE NOT EXISTS (SELECT 1 FROM "permissions" WHERE "key" = 'system.backups.view');

INSERT INTO "permissions" ("key", "module", "description")
SELECT 'communication.send_employee_announcements', 'Communication', 'Send announcements to staff by role'
WHERE NOT EXISTS (SELECT 1 FROM "permissions" WHERE "key" = 'communication.send_employee_announcements');
