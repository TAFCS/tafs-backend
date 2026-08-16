# Archived unsafe scripts — do not run

These scripts wrote `device_user_mappings` (and in one case `zk_attendance_scans`)
using **heuristics** rather than an explicit operator decision. They are kept for
historical reference only. Each aborts immediately via `\quit` if executed.

| Script | Core hazard |
|---|---|
| `DO-NOT-RUN.backfill-student-device-pin-mappings.sql` | Guesses the student from `gr_number == device_pin` / `cc == device_pin`, and **re-points live active mappings**. GR numbers and CCs share one numeric namespace (199 known collisions), so this attributes scans to the wrong student. |
| `DO-NOT-RUN.backfill-device-pin-mappings.sql` | Reconstructs `employee_code` from a pin using a rule inferred from two examples; no collision check. |

## What replaced them

`device_user_mappings` is now the source of truth, and every change to it
re-derives the affected scans and rebuilds the affected daily attendance:

- **Change a mapping** — `POST` / `PATCH` / `DELETE /attendance/zk-device-mappings`.
  Collision-guarded, and re-resolves that PIN's history inline.
- **Bulk repair** — `POST /attendance/zk-scan-resolution/resolve`.
  Dry-run by default; review the diff, then re-send with `"dry_run": false`.
- **Diagnose** — `npx ts-node scripts/audit-zk-scan-attribution.ts` (read-only).

## Also superseded

These ran against production during the August 2026 mapping cleanup and are kept
in `scripts/` as a record, but should not be reused — they bypass the lifecycle
hooks and leave scans attributed to people who no longer have a mapping:

- `delete-student-device-mappings-for-remap.ts` → use `DELETE /attendance/zk-device-mappings/:id`
- `wipe-duplicate-student-device-mappings.ts` → use the same DELETE route
- `unlink-student-device-mappings.ts` → use `PATCH … { "is_active": false }`
- `fix-student-device-pin-gr-mismatch.ts` → use `PATCH` (re-pinning is not supported;
  create the new mapping and delete the old one so history follows)
