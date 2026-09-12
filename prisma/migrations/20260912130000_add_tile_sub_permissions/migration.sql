-- Tile sub-permissions: "what may they DO once they are inside a tile".
--
-- The tile layer answered "which tiles can this person see". It could not
-- answer the next question. Employee Directory is one tile whose ~25 backend
-- routes collapse to exactly two checks (Read Employee / Manage Employee), so
-- editing a phone number, changing a salary, deleting an employee and
-- revealing a portal password were all the same permission.
--
-- These three tables mirror the tile ones exactly:
--   access_tiles              -> access_tile_actions
--   access_pack_tiles         -> access_pack_tile_actions
--   user_tile_grants          -> user_tile_action_grants
--
-- access_tile_actions is owned by AccessSync, projected from TILES_MANIFEST on
-- boot, the same way access_tiles already is. Rows exist so pack and grant FKs
-- resolve; the live catalog is still served from memory.
--
-- A tile that declares no actions in the manifest keeps its old all-or-nothing
-- behaviour, so this is inert until a tile opts in.

CREATE TABLE "access_tile_actions" (
  "tile_id"     VARCHAR(80) NOT NULL,
  "action_id"   VARCHAR(60) NOT NULL,
  "label"       VARCHAR(100) NOT NULL,
  "description" VARCHAR(255),
  "is_default"  BOOLEAN NOT NULL DEFAULT false,
  "sort_order"  INTEGER NOT NULL DEFAULT 0,
  "is_active"   BOOLEAN NOT NULL DEFAULT true,

  CONSTRAINT "access_tile_actions_pkey" PRIMARY KEY ("tile_id", "action_id")
);

CREATE INDEX "access_tile_actions_tile_id_idx" ON "access_tile_actions" ("tile_id");

ALTER TABLE "access_tile_actions"
  ADD CONSTRAINT "access_tile_actions_tile_id_fkey"
  FOREIGN KEY ("tile_id") REFERENCES "access_tiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "access_pack_tile_actions" (
  "pack_id"   TEXT NOT NULL,
  "tile_id"   VARCHAR(80) NOT NULL,
  "action_id" VARCHAR(60) NOT NULL,

  CONSTRAINT "access_pack_tile_actions_pkey" PRIMARY KEY ("pack_id", "tile_id", "action_id")
);

CREATE INDEX "access_pack_tile_actions_tile_id_action_id_idx"
  ON "access_pack_tile_actions" ("tile_id", "action_id");

ALTER TABLE "access_pack_tile_actions"
  ADD CONSTRAINT "access_pack_tile_actions_pack_id_fkey"
  FOREIGN KEY ("pack_id") REFERENCES "access_packs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "access_pack_tile_actions"
  ADD CONSTRAINT "access_pack_tile_actions_tile_id_action_id_fkey"
  FOREIGN KEY ("tile_id", "action_id")
  REFERENCES "access_tile_actions"("tile_id", "action_id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "user_tile_action_grants" (
  "user_id"    TEXT NOT NULL,
  "tile_id"    VARCHAR(80) NOT NULL,
  "action_id"  VARCHAR(60) NOT NULL,
  "allow"      BOOLEAN NOT NULL,
  "granted_by" TEXT NOT NULL,
  "granted_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "note"       VARCHAR(255),

  CONSTRAINT "user_tile_action_grants_pkey" PRIMARY KEY ("user_id", "tile_id", "action_id")
);

CREATE INDEX "user_tile_action_grants_tile_id_action_id_idx"
  ON "user_tile_action_grants" ("tile_id", "action_id");

ALTER TABLE "user_tile_action_grants"
  ADD CONSTRAINT "user_tile_action_grants_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_tile_action_grants"
  ADD CONSTRAINT "user_tile_action_grants_granted_by_fkey"
  FOREIGN KEY ("granted_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "user_tile_action_grants"
  ADD CONSTRAINT "user_tile_action_grants_tile_id_action_id_fkey"
  FOREIGN KEY ("tile_id", "action_id")
  REFERENCES "access_tile_actions"("tile_id", "action_id") ON DELETE CASCADE ON UPDATE CASCADE;
