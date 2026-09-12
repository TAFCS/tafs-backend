# Handoff — universal scope + tile sub-permissions

**Status (2026-09-12, end of day):** the foundation is built, **deployed, and
migrated**, and the first two items of the rollout are done. This file is the
recipe for the rest, one page at a time.

Everything below is on `main` in both repos. Design rationale lives in
`TASK_scope_and_tile_subpermissions.md`; this file is the how.

### Done

| | Where |
|---|---|
| Foundation — scope tables, manifest actions, guards, session wiring | tafs-backend `082fed2`…`fa768c9` |
| Migrations applied to the shared production DB | `migrate status` clean; 223 scope rows backfilled (200 CAMPUS, 23 CLASS), 28 tile actions projected |
| Client types + `useTileAccess` / `useUserScope` | tafs-webapp `adcf427` |
| **People & Access panel** — Scope tab, tri-state sub-permissions | tafs-webapp `865d7b6` (rollout item 1) |
| **Employee Directory backend** — scope + `@RequireAction` on 25 routes + field partitioning | tafs-backend `4848c68` (rollout item 2, steps 3–5) |
| **Employee Directory UI** — tabs, cards and controls gated | tafs-webapp `07aaa55` (step 6) |

### Not done — this is your work

Rollout items **3, 4 and 5** in §4. Every tile other than Employee Directory is
still all-or-nothing, and the scope sweep across the 12 + 5 duplicated call
sites has not started.

---

## 1. What exists now

Two orthogonal layers that multiply. Both must pass on every request.

```
          WHAT you may do                    WHICH records you may do it to
        ┌─────────────────────┐            ┌──────────────────────────────┐
        │ tile sub-permission │     ×      │ universal scope ("can touch")│
        │ hr.employee_        │            │ campuses / segments /        │
        │ directory#          │            │ classes / sections /         │
        │ schedule_pay.edit   │            │ departments / categories     │
        └─────────────────────┘            └──────────────────────────────┘
```

### Backend (`tafs-backend`)

| Piece | Where | What it does |
|---|---|---|
| `user_scope_entries` + `ScopeDimension` | `prisma/schema.prisma` | One row per (user, dimension, ref_id) |
| `ScopeService` | `src/common/scope/scope.service.ts` | **The** scope helper. `resolve`, `setScope`, `assertCampus/Segment/Class/Section/Department/StaffCategory`, `assertEmployee`, `canSeeEmployee`, `whereForEmployees`, `whereForStudents`. Global module — just inject it |
| Pure scope logic | `src/common/scope/scope.types.ts` | `UserScope`, `scopeAllows`, `whereForEmployees/Students`. No DB, fully unit-tested |
| `TileAction`, `EMPLOYEE_DIRECTORY_ACTIONS` | `src/modules/access/tiles.manifest.ts` | Sub-permission catalog. **This is the file you edit to add actions** |
| Action resolution | `src/modules/access/access.effective.ts` | `computeEffectiveAccess` now returns `actionIds` |
| `@RequireAction` / `@RequireAnyAction` | `src/decorators/require-action.decorator.ts` | Route-level enforcement |
| `TileActionGuard` | `src/common/guards/tile-action.guard.ts` | Enforces the decorator. No-op on undecorated routes |
| `readUntilMigrated` | `src/utils/pending-migration.util.ts` | P2021/P2022 degradation — see §2 |
| Session wiring | `src/modules/auth/auth.service.ts` `issueStaffSession` | Puts `scope` + `actions` on the JWT and login response |
| Scope API | `src/modules/access/access.controller.ts` | `GET /v1/access/scope-options`; scope rides on `GET`/`PUT /v1/access/users/:id/access` |

### Webapp (`tafs-webapp`)

| Piece | Where |
|---|---|
| `UserScope`, `StaffUser.effectiveActions`, `StaffUser.scope` | `src/store/slices/authSlice.ts` |
| `useTileAccess(tileId)` → `can / canAny / canAll / hasTile` | `src/hooks/use-tile-access.ts` |
| `useUserScope()` → `allows / filterOptions / isRestricted` | `src/hooks/use-tile-access.ts` |
| `AccessCatalogAction` on catalog tiles | `src/lib/nav-config.ts` |

### Semantics you must internalise

- **Empty scope dimension = UNRESTRICTED, not "nothing".** A user with zero
  scope rows sees everything, exactly as before.
- **Dimensions AND together.** Campus [1] + Department [3] = Academics staff at
  Johar only.
- **Once a dimension is restricted, `null` ids fall outside it.** A user scoped
  to campus [1] does *not* see records with `campus_id = null`. Deliberate —
  half-configured rows stay out of scoped lists.
- **Actions only resolve for tiles the user actually holds.** Granting an action
  on an unreachable tile is a no-op; denying a tile takes its actions with it.
- **Granting a tile confers only its `default: true` actions.** Everything else
  is explicit.
- **`implies` expands transitively** (`profile.edit → profile.view → view`), and
  **denials expand in reverse** — denying `profile.view` also removes
  `profile.edit`.
- **SUPER_ADMIN bypasses both layers, everywhere.**

---

## 2. Deploy order — read before shipping anything

The datasource is the **shared remote DB** and `prisma migrate deploy` is run
deliberately, so code reaches production *before* its migration does
(CLAUDE.md rule 11). Every new read is already wrapped in `readUntilMigrated`,
so an unmigrated deploy degrades instead of exploding:

- scope falls back to unrestricted (what those sessions already had)
- sub-permissions stay inert (what tiles already did)

Each logs **one** warning naming the migration to run.

**Order — ALL FIVE STEPS ARE DONE for the migrations named below.** Repeat this
sequence for any *new* migration the remaining work introduces.

1. ~~Merge and deploy the code.~~ Done.
2. ~~`npx prisma migrate deploy`~~ — `20260912120000_add_user_scope_entries` and
   `20260912130000_add_tile_sub_permissions` are applied.
3. ~~Restart~~ — done; `access_tile_actions` holds 28 rows.
4. ~~`npx prisma migrate status`~~ — says "Database schema is up to date!"
5. Routes may now be decorated freely.

> **A hole this sequence does not cover.** Reads degrade via
> `readUntilMigrated`, but the **writes do not**: `setUserAccess` rewrites
> `user_tile_action_grants` whenever `tileActionGrants` is present, and
> `ScopeService.setScope` writes `user_scope_entries` unguarded. On an
> unmigrated DB either one raises P2021 and fails the *whole* access save. This
> bit once already (a 500 on `PUT /v1/access/users/:id/access`). The webapp
> works around it by only sending `tileActionGrants` when an override exists
> (`hasActionOverrides` in the People & Access page) — that is a client-side
> patch for a server-side hole. Fix the write path before the next
> access-layer migration.

### The 90-day token trap

`@RequireAction` denies any caller whose token has no `actions` — and access
tokens live **90 days**. The webapp refreshes on mount, so real users self-heal
on their next page load, but:

> **Never decorate routes in the same deploy that first ships the session
> wiring.** Ship session wiring, let it roll out, decorate in a later deploy.

That wiring is already in commit `c8087ab`, so once it is deployed you are clear.

---

## 3. The per-page recipe

Six steps. Skip none — step 4 is the one people forget and it is a hole.

### Step 1 — Declare the tile's actions

`tafs-backend/src/modules/access/tiles.manifest.ts`. Copy the shape of
`EMPLOYEE_DIRECTORY_ACTIONS`.

```ts
const VOUCHERS_ACTIONS: TileAction[] = [
  { id: 'view',   label: 'Open vouchers', default: true },
  { id: 'issue',  label: 'Issue a voucher',  implies: ['view'] },
  { id: 'delete', label: 'Delete a voucher', implies: ['view'] },
];
```

Rules:
- Exactly one action carries `default: true` — the "open this tile" action.
- One `X.view` / `X.edit` pair per tab, `X.edit` implying `X.view`.
- Discrete verbs (`delete`, `export`, `status.change`) imply the tab they act on.
- Action ids are permanent. Renaming one orphans every grant pointing at it.

### Step 2 — Declare the legacy bridge

```ts
legacyFullAccessCapabilities: ['finance.vouchers.edit'],
```

Holding that capability confers **every** action of the tile. **This is not
optional.** Without it, the day you ship actions, every role that had blanket
edit rights silently loses them. Pick the capability that today means "can do
anything in this tile".

Remove the bridge only once every role carrying that capability has been
re-expressed as packs and actions.

### Step 3 — Decorate the routes

```ts
import { RequireAction } from '../../decorators/require-action.decorator';
import { TileActionGuard } from '../../common/guards/tile-action.guard';

@Controller('vouchers')
@UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)   // add, don't replace
export class VouchersController {

  @Delete(':id')
  @CheckPolicies((a) => a.can(Action.Manage, 'Voucher'))     // keep the coarse check
  @RequireAction('finance.vouchers#delete')                  // add the fine one
  async remove(...) {}
}
```

`TileActionGuard` goes **alongside** `PoliciesGuard`, never instead of it. CASL
keeps guarding the capability layer; this adds the sub-permission layer; both
must pass.

### Step 4 — Field-partition any multi-tab write

**The step that turns tab permissions into theatre if you skip it.**

A `PATCH /:id` that writes fields belonging to several tabs cannot be guarded by
a single action — someone with only `profile.edit` would PATCH `monthly_pay`
straight through. Map every DTO field to its owning tab and reject per field:

```ts
const FIELD_TAB_MAP: Record<string, string> = {
  full_name: 'profile',  cnic: 'profile',  personal_phone: 'profile',
  department_id: 'employment',  job_title: 'employment',
  monthly_pay: 'schedule_pay',  reporting_time: 'schedule_pay',
  // ...every field in UpdateEmployeeDto
};

function assertFieldsEditable(dto: object, held: Set<string>, tileId: string) {
  const denied = Object.keys(dto)
    .filter((f) => dto[f] !== undefined)
    .filter((f) => {
      const tab = FIELD_TAB_MAP[f];
      return tab && !held.has(`${tileId}#${tab}.edit`);
    });
  if (denied.length > 0) {
    throw new ForbiddenException(
      `You may not edit: ${denied.join(', ')}.`,
    );
  }
}
```

A field missing from the map is **unguarded**. Add a test asserting every key of
the DTO appears in `FIELD_TAB_MAP`, so a new field fails CI rather than shipping
an unguarded write.

### Step 5 — Scope the queries

Inject `ScopeService`. Two patterns:

**Lists** — merge the where fragment:

```ts
async findAll(user: IJwtStaffPayload) {
  return this.prisma.employee_profiles.findMany({
    where: { ...this.scope.whereForEmployees(user) },
  });
}
```

**Single records** — assert before acting, and **404, never 403**, so the
endpoint cannot be used to enumerate records at other campuses:

```ts
const emp = await this.prisma.employee_profiles.findUnique({
  where: { id },
  select: { campus_id: true, segment_id: true, department_id: true, staff_category_id: true, /* ... */ },
});
if (!emp || !this.scope.canSeeEmployee(user, emp)) {
  throw new NotFoundException(`Employee ${id} not found`);
}
```

**Creates/moves** — assert the *target* is in scope, or a scoped user can push a
record out of their own reach:

```ts
this.scope.assertCampus(user, dto.campus_id);
```

Many controllers do not currently pass `@CurrentUser()` into the service at all.
Threading it through is part of this step.

**While you are in a file that has its own `private assertCampusAccess`, delete
it and use `ScopeService`.** Twelve services still carry a copy:

```
attendance/attendance-objections.service.ts    hr/leaves/leave-requests.service.ts
attendance/class-session-reschedules.service.ts hr/payroll/payroll.service.ts
attendance/roll-sessions.service.ts             hr/saturday-schedules/saturday-schedules.service.ts
attendance/staff-attendance.service.ts          hr/shift-overrides/shift-overrides.service.ts
attendance/staff-lesson-reschedules.service.ts  timetables/teaching-groups.service.ts
attendance/student-attendance.service.ts        timetables/timetables.service.ts
```

Five more read `user.allowedClassIds` directly and should move to
`scope.classes`: `roll-sessions`, `student-attendance`, `students.service.ts`,
`analytics.controller.ts` (×2).

### Step 6 — Gate the UI

```tsx
const emp = useTileAccess("hr.employee_directory");
const { filterOptions } = useUserScope();

const tabs = BASE_TABS.filter((t) => emp.can(`${t.id}.view`));
<SalaryField readOnly={!emp.can("schedule_pay.edit")} />
{emp.can("delete") && <DeleteButton />}

// pickers offer only what the user may choose
const campusOptions = filterOptions("campuses", allCampuses, (c) => c.id);
```

`useTileAccess` **hides and disables — it is not the boundary.** The API is.
A page with step 6 but not step 3 is unprotected.

---

## 4. Rollout order

1. ~~**The People & Access panel itself.**~~ **DONE** (`865d7b6`). A fourth
   **Scope** tab with six chip pickers over `GET /v1/access/scope-options`,
   each reading "All" when empty; tiles in the Access tab expand into tri-state
   sub-permissions. **Still missing: the same expansion in the Access Packs
   editor** — `listPacks` does not return `tileActions` yet (only
   `getUserAccess.allPacks` does), so that endpoint needs widening first.
2. ~~**Employee Directory**~~ — **DONE**, backend `4848c68` and UI `07aaa55`.
   §5 is kept below as the worked example to copy for the next tile.
3. **Scope-only sweep** — steps 5 alone across the 12 + 5 call sites above.
   No manifest or UI work; pure de-duplication, immediately visible.
4. **Remaining tiles, riskiest first** — Payroll, Vouchers, People & Access.
5. **Retire `users.campus_id` and `allowed_class_ids`.** Only once nothing reads
   them. `campus_id` carries an FK to `campuses` and appears in several
   `select` blocks in `users.service.ts`, so it is its own reviewed change —
   do not bundle it.

---

## 5. Worked example — Employee Directory

**All six steps are done for this tile.** It is kept here as the worked example
— read it as "this is what finished looks like", then do the same for yours.

Manifest entry and its 28 actions: `tiles.manifest.ts`,
`EMPLOYEE_DIRECTORY_ACTIONS`, bridged on `hr.employees.edit`.

One gap left on it deliberately: the Advanced form
(`/hr/employees/[id]/edit`, `EmployeeForm.tsx`) is gated at the entrance — you
need at least one `*.edit` — but its ~47 fields are **not** individually gated.
`PATCH /:id` field-partitions against `EMPLOYEE_FIELD_TAB_MAP`, so a caller
without `schedule_pay.edit` gets a 403 naming the refused fields rather than a
silent save. Threading tab ownership through that form is its own change.

Tabs come from `BASE_TABS` in `EmployeeDetailPanel.tsx` — note the tab there is
`schedule` but the action is `schedule_pay.*`.

### Route map (`hr/employees/employees.controller.ts`)

| Route | Action |
|---|---|
| `GET /`, `GET /:id`, `GET /search-simple`, `GET /unlinked-users`, `GET /next-code` | `view` |
| `GET /export`, `GET /export-master-excel` | `export` |
| `POST /` | `create` |
| `DELETE /:id` | `delete` |
| `PATCH /:id/status` | `status.change` |
| `PATCH`/`DELETE /:id/work-schedule`, `PATCH /:id/increment-cycle` | `schedule_pay.edit` |
| `GET /:id/salary-increment*` | `schedule_pay.view` |
| `GET /:id/progression` | `progression.view` |
| `PATCH /:id/account` | `portal.edit` |
| `POST /:id/account/reset-password` | `portal.reset_password` |
| `PATCH /:id/account/username` | `portal.change_username` |
| `GET /:id/account/reveal-password` | `portal.reveal_password` |
| `POST /:id/previous-employers`, `DELETE /previous-employers/:id` | `profile.edit` |
| `PATCH /:id` | **field-partitioned, step 4** |

### Scope

`EmployeesService.findAll()` currently takes no caller and returns **every
employee at every campus** — the controller never passes the user. Thread
`@CurrentUser()` through `findAll`, `searchSimple`, `exportExcel`,
`exportMasterExcel` and merge `whereForEmployees`. Every `:id` route gets the
`canSeeEmployee` → 404 treatment.

Employees are scoped by **campus, segment, department, staff_category** — not by
class or section. An employee's link to a class is an assignment
(`employee_class_section_assignments`), not an attribute; scoping on it would
hide every non-teaching employee from a class-scoped user. If you decide
otherwise later, change `whereForEmployees` in `scope.types.ts`, not a call site.

---

## 6. Per-page checklist

```
[ ] Actions declared in tiles.manifest.ts, exactly one `default: true`
[ ] legacyFullAccessCapabilities set to today's "can do anything here" capability
[ ] TileActionGuard added to @UseGuards, alongside PoliciesGuard
[ ] Every route decorated with @RequireAction
[ ] Multi-tab writes field-partitioned + a test that every DTO key is mapped
[ ] @CurrentUser() threaded into the service
[ ] List queries merge the scope where-fragment
[ ] :id lookups 404 (not 403) when out of scope
[ ] Creates/moves assert the TARGET is in scope
[ ] Any private assertCampusAccess in the file deleted, ScopeService used
[ ] UI hides/disables via useTileAccess; pickers narrowed via useUserScope
[ ] Verified: grant only `X.view` → tab read-only, siblings absent, API 403s directly
[ ] Verified: legacy role with the bridge capability still does everything
[ ] Verified: scoped user sees a filtered list and 404s on a foreign :id
[ ] Verified: SUPER_ADMIN unaffected
```

---

## 7. Tests

```bash
cd tafs-backend
npx jest src/common/scope src/common/guards src/modules/access src/modules/auth
npx nest build
```

45 specs cover the foundation: scope AND-ing / empty-is-unrestricted / null
exclusion, action defaults, `implies` expansion, reverse-implies denial, the
legacy bridge, denied tiles, and SUPER_ADMIN bypass on both layers.

`npx tsc --noEmit` in `tafs-backend` reports pre-existing errors in `scripts/`
(stale models: `staff_types`, `designations`) and in `*.spec.ts` (no jest types
in that tsconfig). Both predate this work. `npx nest build` is the real gate and
is clean.

---

## 8. Open decisions

- **Class/section scope for employees** — currently not applied (see §5).
- **Removing the legacy bridge** — blocked until legacy roles are re-expressed
  as packs. Until then a role with `hr.employees.edit` bypasses every Employee
  Directory sub-permission, which is intended but worth stating out loud.
- **Scope on students** — `whereForStudents` exists and is tested but has no
  caller yet.
- **Scoping the admin panel itself** — should a campus-scoped admin be able to
  grant access outside their own scope? Currently yes. Probably wants to be no.
