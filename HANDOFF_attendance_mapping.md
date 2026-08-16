# Handoff — attendance mapping as source of truth

Branch: `fix/attendance-mapping-source-of-truth`
Webapp changes ride on `tafs-webapp` `main`.
Last updated: 16 Aug 2026

---

## The problem this solves

Biometric scans resolved a person **once, at ingest**, and froze that identity onto
`zk_attendance_scans.employee_id` / `.student_cc`. `device_user_mappings` was never
consulted again. So correcting a mapping had **zero effect on history** — a student
remapped to a new pin kept the old pin's attendance forever, and a mis-mapped pin
credited someone else's attendance permanently.

Now: **any change to a mapping replays that pin's history.** Create, update,
deactivate or delete re-derives every scan on that pin from the current mapping and
rebuilds the affected daily rows — on *both* sides, so the person losing the day
loses it and the person gaining it gains it.

---

## Done

| Commit | What |
|---|---|
| `c4a49a1` | Records the cleanup scripts that were already run against prod |
| `d46c761` | Day-recompute primitives + read-only audit script |
| `6c2a648` | Re-resolution engine; repaired the pin-6102 misattribution |
| `468bc67` | **Lifecycle hooks — the actual reported bug fix** |
| `0da99a5` | GR/CC collision guard + `idx_students_gr_number` |
| `7bad2d7` | Archived the heuristic backfill scripts as do-not-run |
| `46451c9` | Link/unlink previews + 20x preview speedup + loud skip |
| `116a53a` | This handoff note |
| _(head)_ | Bulk day-segment rebuild + person memo; frontend confirm steps |

**Verified end to end** on real data: attendance follows the pin across
activate → deactivate → remap → delete. SYSTEM holidays and MANUAL gate-desk
scans are never touched.

### Data repaired in production
Pin `6102` on `NYU7261205142` — AIZA BAIG's GR number collided with MUHAMMAD HAIB
MIRZA's CC. 4 scans repointed, AIZA's phantom Aug-13 row deleted, her Aug-12
check-in corrected 07:27 → 10:15, HAIB MIRZA gained both days. Audit
mis-attribution count: **4 → 0**.

### Migration already applied to the live DB
`20260816160000_add_students_gr_number_index` — additive index, also affects `main`.

---

## Write-path performance — resolved, and the numbers were misleading

An earlier version of this note called the write path "⚠️ blocking" at **70s** to
deactivate a 118-scan pin and **133s** to reactivate. That framing was wrong, and
it is worth recording why so nobody re-opens it.

**Measured against this DB: a trivial `SELECT 1` costs ~574ms.** Ping to
`db-postgresql-sgp1-...ondigitalocean.com` is 85ms, and pgbouncer's transaction
wrapping plus TLS multiplies that. So local wall-clock is almost entirely a
function of *how far the developer's laptop is from Singapore*, not of the code.
The only latency-independent metric is **round-trip count**. Measure that, not
seconds, and never benchmark this from a laptop.

Batching landed anyway, because fewer round trips is strictly better and it helps
production too:

- `prepareDaySegments` (processor) re-derives duplicates **and** sequence numbers
  for every affected person-day in **one** query plus a handful of grouped
  `updateMany` calls, replacing a per-day `findMany` + a transaction of individual
  per-scan updates. This is the same shape as `projectAllDays` on the preview side.
- `beginBatch()` / `endBatch()` on the processor memoises the person record
  (`students` / `employee_profiles`) for the run — it is the same one or two people
  across every day.

Round trips for the 118-scan / 27-day case dropped roughly **by half** (~122 → ~72;
wall-clock 70s → 43.5s locally, and reactivate 133s → 92s). In production, where
the API and DB are co-located, that is sub-second either way.

`prepareDaySegments` deliberately buckets only the person-days that were requested:
its id×date query is a cross product, and a rebuild must never renumber a day
nobody asked about.

---

## Frontend — done

All four mapping surfaces now go through one shared confirm step,
`src/components/attendance/mapping-impact-dialog.tsx` (webapp):

| Surface | File |
|---|---|
| Unmapped PINs (the one-click offender) | `zk-device-logs/_components/unmapped-pins-tab.tsx` |
| PIN Mappings list + create/edit modal | `zk-device-logs/_components/pin-mappings-tab.tsx` |
| Student directory → Biometric | `identity/students/tabs/StudentBiometricTab.tsx` |
| Employee directory → Biometric | `hr/employees/_components/EmployeeBiometricTab.tsx` |

The dialog fetches `preview-link` / `preview-unlink` on open, renders the real
impact (scans linked/moved/unlinked, days appearing/recalculated/removed/protected),
shows collisions, and only then enables the confirm button.

Design decisions worth keeping:

- **Renaming never prompts.** A display-name or notes edit can't move attendance,
  so it saves straight through. Only a create, a repoint, or an `is_active` flip
  opens the dialog — see `movesAttendance()` in `pin-mappings-tab.tsx`.
- **BLOCK collisions require a typed-out acknowledgement checkbox**, which then
  sends `acknowledge_collisions: true`. WARN collisions are advisory only.
- **`extraNotes`** carries context the backend collision check doesn't cover —
  currently "this student is already mapped to N other PINs".
- **Reactivating gets the link dialog, not a silent toggle** — claiming a pin's
  history back is as consequential as releasing it.
- **`reportRebuildIfNeeded`** turns `needs_rebuild` into a sticky toast with a
  "Rebuild now" action wired to `/zk-scan-resolution/resolve`. It returns `true`
  so callers skip their own success toast — otherwise "Mapped!" and "not rebuilt"
  appear together and contradict each other.
- The quick-link buttons on Unmapped PINs now read **"Review"**, not "Link" — the
  label had to stop promising a one-click commit.

`DELETE /:id` is now reachable from the UI (trash icon on all three mapping
tables). It previously existed only as an endpoint, with operators falling back to
ad-hoc scripts.

---

## Endpoint contracts for the UI

All under `/api/v1`, SUPER_ADMIN only.

### Preview a link — before mapping an unmapped pin
```
POST /attendance/zk-scan-resolution/preview-link
{ "device_sn": "...", "device_pin": "...", "person_type": "STUDENT",
  "student_cc": 44 }            // or person_type STAFF + employee_id
```
```json
{ "scans_linked": 272, "days_appearing": 141, "days_recalculated": 0,
  "days_removed": 0, "days_protected": 0, "affects_other_people": [],
  "reversible": true,
  "summary": "272 scans will be linked, 141 days of attendance will appear." }
```

### Preview an unlink — before delete or deactivate
```
POST /attendance/zk-scan-resolution/preview-unlink
{ "device_sn": "...", "device_pin": "..." }
```
→ `"118 scans will be unlinked, 23 days will stop showing."`

A pin with no history returns `"No attendance will change."`

### Mutations (each re-resolves inline and returns a `resolution` report)
```
POST   /attendance/zk-device-mappings              create / reactivate
PATCH  /attendance/zk-device-mappings/:id          repoint or is_active toggle
DELETE /attendance/zk-device-mappings/:id          unlink + release scans
GET    /attendance/zk-device-mappings/collision-check?device_sn=&device_pin=&person_type=&student_cc=
```

### UI copy guidance
Unlinking is **reversible** — raw logs are never deleted, and with student LATE
marking off it is fully lossless. Don't warn as if it were destructive:

> Unlink this pin? **23 days** of attendance for AAWAIZ ALI will stop showing.
> The scans are kept — re-linking the pin restores them.

Two states the UI must handle:
- **409 collision** — body carries `collisions[]`; `BLOCK` entries name the
  conflicting student. Offer `acknowledge_collisions: true` as a deliberate override.
- **`resolution.needs_rebuild === true`** — pin exceeded the 2000-scan inline limit.
  The mapping saved but history did **not** rebuild. Surface this prominently; the
  response includes `resolve_request` to POST to `/zk-scan-resolution/resolve`.

---

## Landmines (each of these already bit me)

- **Postgres advisory locks don't work here.** Session-scoped, but Prisma pools
  connections and this DSN uses pgbouncer, so the unlock lands on a different
  connection and leaks the lock permanently. The guard is deliberately in-process
  (`ZkScanResolutionService.running`). Don't "fix" it back.
- **Never run `npx nest build` while `npm run start:dev` is watching** — it wipes
  `dist` mid-compile and the server dies with an unrelated `MODULE_NOT_FOUND`. For
  API testing, build once and run `node dist/src/main.js`.
- **Never benchmark this DB from a laptop.** ~574ms per query from here; ~85ms of
  that is raw ping to Singapore. Count round trips instead of stopwatching.
- **A one-off script must live under `tafs-backend/scripts/`** or `ts-node` can't
  resolve `@prisma/client`. Writing it to a temp dir fails to compile.
- **`recomputeDaySequence` with a null person id** would renumber every
  unattributed scan that day. Guarded by `assertPersonId` — keep it.
- **Prisma `undefined` means "skip this column"**, not "set null". All three person
  columns must be written explicitly. This was the original never-cleared bug.
- **`MANUAL` device_sn is excluded from resolution** by design (gate-desk punches
  have no mapping). Exclude it from any new scope or report or it reads as a
  permanent orphan.
- **Dry-run must project POST-move counts**, not current ones — otherwise it
  predicts `UPSERTED` for a day that will actually be `CLEARED`.
- **`excludeToday` and `dry_run` both default to true.** Deliberate.

---

## Known limitations

- **LATE marks don't survive a rebuild that empties a day.** With
  `STUDENT_LATE_MARKING_ENABLED = false`, any recomputed student day is `PRESENT`;
  if a day is cleared the stored `LATE` is gone. There's a partial guard in
  `recomputePersonDay` for days that survive, but delete→recreate can't be covered.
  Only real fix is re-enabling late marking. User has accepted this.
- **`attendance_objections` can go stale.** An objection references `(employee_id,
  scan_id)`; repointing that scan makes the pair incoherent. Designed but never
  implemented — only 3 rows exist today.
- **No unit tests on the new primitives.** The weakest point for future-proofing.
  `recomputePersonDay`, `resolvePersonRef`, `projectAllDays` all deserve coverage.
- **Concurrency guard is per-process.** Fine on one instance; would need rework to
  scale horizontally.

---

## Testing notes

**Audit anything with:** `npx ts-node scripts/audit-zk-scan-attribution.ts` — fully
read-only, writes CSVs to the repo parent. Current expected baseline:

```
mis-attributed:      0
orphaned:          247   (students whose mappings were deleted in the Aug cleanup)
phantom dailies:     0
GR/CC collisions:  199   (83 on a live pin)
incoherent columns:  4    (DEV-001 test scans + one stray)
```

The 247 orphans are expected and out of scope — they resolve themselves as those
students get remapped.

**Safe test fixtures**
- `ZAYD SARFARAZ` cc `3717` — no mappings, no scans. Ideal isolated subject.
- Test pins `990001` / `990002` on `NYU7261205142` — free, used and cleaned up before.
- `AAWAIZ ALI` cc `44` — rich real case (pin `9999` on **5 devices**, MANUAL scans,
  SYSTEM holidays). Backup at `../backup-aawaiz-cc44.json`; restore LATE marks from
  it after any test that cycles his mapping.

**Last full deactivate → reactivate cycle on cc 44** (39 daily rows, 122 scans):
all 39 rows returned, every `check_in_at` / `check_out_at` identical, 15 SYSTEM
holidays and the 4 protected rows untouched, 0 rows added or lost. The only delta
was 13 `LATE` → `PRESENT`, restored from the snapshot — that is the known
limitation below, not a regression. Always snapshot the daily rows first; a plain
diff of that snapshot is the strongest correctness check available.

**Always snapshot before touching production data.** There is no separate test DB —
`prisma migrate deploy` and every mutation hit live DigitalOcean Postgres.
