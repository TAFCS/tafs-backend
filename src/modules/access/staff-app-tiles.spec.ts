import { readFileSync } from 'fs';
import { join } from 'path';
import { EMPLOYEE_SELF_SERVICE_PACK, TILES_MANIFEST, catalogFromManifest } from './tiles.manifest';

const staffAppTiles = TILES_MANIFEST.filter((t) => t.module === 'staff_app');

const MIGRATION = readFileSync(
  join(__dirname, '../../../prisma/migrations/20260916130000_staff_app_self_service_backfill/migration.sql'),
  'utf8',
);

/**
 * The keys the TAFS Staff App checks to show each tab
 * (tafs-staff-app lib/features/employee_portal/employee_portal_access.dart).
 * The app reads the KEYS, not the tile ids, so a tile pointing at a different
 * key would grant nothing the app can see.
 */
const APP_TAB_KEYS: Record<string, string> = {
  'staff_app.attendance': 'attendance.self.view',
  'staff_app.timetable': 'hr.timetable.self_view',
  'staff_app.payroll': 'payroll.self.view',
  'staff_app.leave': 'hr.leave.apply',
};

describe('Staff App tiles', () => {
  it('declares exactly the permission-gated app tabs, each on the key the app checks', () => {
    expect(Object.fromEntries(staffAppTiles.map((t) => [t.id, t.capabilities]))).toEqual(
      Object.fromEntries(Object.entries(APP_TAB_KEYS).map(([id, key]) => [id, [key]])),
    );
  });

  it('marks every one as a staff_app surface, never a web route', () => {
    for (const tile of staffAppTiles) {
      expect(tile.surface).toBe('staff_app');
      expect(tile.href.startsWith('staff-app://')).toBe(true);
    }
    // ...and nothing else claims the surface
    expect(TILES_MANIFEST.filter((t) => t.surface === 'staff_app')).toHaveLength(staffAppTiles.length);
  });

  it('carries the surface through to the catalog the admin panel reads', () => {
    const mod = catalogFromManifest().modules.find((m) => m.id === 'staff_app')!;
    expect(mod.tiles.every((t) => t.surface === 'staff_app')).toBe(true);
    const web = catalogFromManifest().modules.find((m) => m.id === 'finance')!;
    expect(web.tiles.every((t) => t.surface === 'web')).toBe(true);
  });

  // The migration upserts access_tiles itself so the pack FKs resolve before
  // AccessSync boots the new manifest. If a tile is added here and not there,
  // the backfill silently skips it for every existing employee.
  it('is backfilled in full by the migration', () => {
    for (const tile of staffAppTiles) {
      expect(MIGRATION).toContain(`'${tile.id}'`);
    }
    expect(MIGRATION).toContain(`'${EMPLOYEE_SELF_SERVICE_PACK}'`);
    expect(MIGRATION).toContain("'hr.timetable.self_view'");
  });
});
