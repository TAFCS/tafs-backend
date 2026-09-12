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
3. ~~**Student Directory**~~ — **DONE**, backend `d0e6c73` and UI `c26c214`.
   The second worked example, and the one to copy when your tile's actions are
   **route-shaped rather than tab-shaped** — see §5b.
4. **Scope-only sweep** — steps 5 alone across the 12 + 5 call sites above.
   No manifest or UI work; pure de-duplication, immediately visible.
5. **Remaining tiles, riskiest first** — Payroll, Vouchers, People & Access.
6. **Retire `users.campus_id` and `allowed_class_ids`.** Only once nothing reads
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

## 5b. Second worked example — Student Directory (route-shaped actions)

Do this one first if your tile has no detail panel with tabs. Employee
Directory is the tab-shaped case; this is the other half, and most tiles look
like it.

**Total diff: two files backend, three frontend, about 90 lines.** It took one
pass. If yours is taking much longer, you are probably field-partitioning
something that does not need it.

### Why the actions look different

`EMPLOYEE_DIRECTORY_ACTIONS` has a `X.view`/`X.edit` pair per tab because
`PATCH /:id` writes fields belonging to several tabs through one route. The
student record has **no multi-tab write**, so there is nothing to partition and
step 4 of the recipe is a no-op. The actions follow the **routes** instead:

```ts
const STUDENT_DIRECTORY_ACTIONS: TileAction[] = [
  { id: 'view', label: 'Open directory', default: true },
  { id: 'payment_history.view', label: 'View payment history', implies: ['view'] },
  { id: 'progression.view',     label: 'View academic history', implies: ['view'] },
  { id: 'assignment.edit',      label: 'Move a student',  implies: ['view'] },
  { id: 'status.change',        label: 'Change status',   implies: ['view'] },
  { id: 'promote',              label: 'Promote',         implies: ['view'] },
  { id: 'export',               label: 'Export to Excel', implies: ['view'] },
];
```

**Rule of thumb.** Group by *what a route lets someone do*, not by where it
appears on screen. Seven actions across seventeen routes is the right order of
magnitude; twenty-eight was only justified because tabs were the unit.

### Route map (`students.controller.ts`)

| Route | Action |
|---|---|
| `GET /`, `GET /:id`, `GET /search-simple`, `GET /fee-benefit-expiry-alerts` | `view` |
| `GET /export` | `export` |
| `GET /:id/payment-history` | `payment_history.view` |
| `GET /:id/academic-history`, `/:id/progression`, `/:id/house-history` | `progression.view` |
| `PATCH /:id/assignment` | `assignment.edit` |
| `PATCH /:id/status`, `/:id/unexpel`, `/:id/undo-left`, `POST /:id/return` | `status.change` |
| `POST /promotion/single`, `/promotion/bulk`, `/gr-numbers/suggest-for-promotion` | `promote` |

Note the last one: a *helper* route for an action gets that action, not `view`.
GR suggestions exist only to feed a promotion, so someone who cannot promote
has no business calling it.

### The trap this tile exposed — do NOT delete the legacy scope helper yet

`students.service.ts` already had `applyStudentScope` (reads `user.campusId`
and `user.allowedClassIds`), exactly the kind of duplicate §3 step 5 tells you
to delete. **Deleting it would have opened access.**

`ScopeService.scopeOf` returns `EMPTY_SCOPE` — *unrestricted* — for a token
with no `scope` claim, and tokens issued before scope shipped have none. They
live **90 days**. So swapping the helper for `whereForStudents` would have
given every un-refreshed session at a scoped campus the whole database until
its token rotated.

What was done instead:

```ts
const legacy = applyStudentScope(user, where, { campus_id, class_id });
const universal = this.scope.whereForStudents(user);
if (Object.keys(universal).length === 0) return legacy;
return { AND: [legacy, universal] };
```

They AND. The new fragment is never *wider* than the old helper, because
migration `20260912120000` backfilled `user_scope_entries` from the very
columns the helper reads — and it adds the section/segment dimensions the
helper never had.

> **Generalise this.** In any file that already scopes by `campusId` /
> `allowedClassIds`, **add** the scope fragment and leave the old check
> standing. The deletion is rollout item 4, done deliberately once tokens have
> rotated — not opportunistically while you are in the file.

### Frontend

`src/hooks/use-student-access.ts` is a copy of `use-employee-access.ts` with
the tile id changed. Copy it again for your tile; the fail-open logic is the
part that matters and it should stay identical everywhere.

Only two of the eight tabs in `StudentDetailPanel` map onto an action, so the
map is declared explicitly rather than inferred:

```tsx
const TAB_ACTION: Record<string, string> = {
  progression: "progression.view",
  class_grade: "assignment.edit",
};
const visibleTabs = TABS.filter((t) => !TAB_ACTION[t.id] || access.can(TAB_ACTION[t.id]));
```

Everything not in the map rides on `view`. **Say so in a comment** — the next
reader will otherwise assume a missing entry is an oversight.

Gate the **button and the body**, not just the button. `setTab("danger_zone")`
is reachable from state even when its button is hidden, so both the control and
`{activeTab === "danger_zone" && <DangerZoneTab …>}` carry the check.

---

## 5c. Things that bit us, in order of how much time they cost

Written down so you do not rediscover them.

1. **A UI `filter()` on `tabs` needs an `activeTab` fallback.** `?tab=` comes
   from the URL and tabs can appear late (Employee `portal` only exists once
   the record loads). Filtering alone leaves the panel rendering nothing.
   Both panels compute `activeTab = tabs.some(t => t.id === tab) ? tab : tabs[0]?.id`.

2. **A tile-holder with no view actions must not see a blank page.** Employee
   Directory prints "You can open this record, but not any of its sections."
   Do the same rather than shipping an empty div.

3. **`sessionPredatesActions` on `useTileAccess` does not work.** `AuthContext`
   normalises `effectiveActions ?? []`, so "absent" and "empty" are
   indistinguishable by the time a component sees it. The working discriminator
   is `hasTile && !can('view')` — granting a tile always confers its
   `default: true` action, so that combination can only be a stale token. Both
   `use-employee-access.ts` and `use-student-access.ts` fail open on it.

4. **Writes are not migration-guarded.** Reads degrade through
   `readUntilMigrated`; `setUserAccess` and `ScopeService.setScope` do not. On
   an unmigrated DB either raises P2021 and fails the *entire* access save. This
   shipped and caused a 500 on `PUT /v1/access/users/:id/access`. Still open —
   the webapp patches around it with `hasActionOverrides`.

5. **`prisma migrate deploy` is not enough — the backend must also restart.**
   `AccessSync` projects `access_tile_actions` on boot, and
   `user_tile_action_grants` has an FK onto it. Between the migration and the
   restart, every sub-permission save fails the constraint. Check:
   `select count(*) from access_tile_actions` — 0 means it has not booted since.

6. **Scope rows exist long before anything reads them.** The migration
   backfilled 223 rows on day one, but they did nothing until the first tile
   was wired. Do not conclude scope is broken because a scoped user still sees
   everything — check whether *that tile* has been done.

7. **Exports are the hole people forget.** A scoped list with an unscoped
   `GET /export` is a one-click dump of everything the list refuses to show.
   Both directories merge scope into the export query. Check yours.

8. **404, never 403, on `:id`.** Both tiles do this. A 403 confirms the record
   exists and turns the route into an enumerator.

### How to verify a tile in five minutes

No test harness needed — People & Access can express all of it:

1. Pick a victim account. Give it the tile and **nothing else**. It should see
   the list and open a record, with every optional tab and button gone.
2. Add one `X.view`. That tab appears, read-only. Its `X.edit` sibling is absent.
3. Add `X.edit`. The pencil appears and a save works.
4. Deny `X.view` explicitly with the tile still granted. `X.edit` must vanish
   too — denials expand in reverse through `implies`.
5. Set a campus scope. The list shrinks; **the Excel export shrinks with it**;
   a foreign `:id` returns 404, not 403.
6. Log in as a role carrying the legacy bridge capability
   (`hr.employees.edit` / `students.directory.edit`). It must still do
   everything — that is the bridge working, not a bug.
7. SUPER_ADMIN sees everything throughout.

Remember the victim account must **reload the page** after any change: scope
and actions ride on the JWT, and `refreshStaffToken` re-resolves both from the
database on the next page load.

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
[ ] UI hides/disables via a use<Tile>Access copy; pickers via useUserScope
[ ] Tab lists that filter also compute an activeTab fallback
[ ] Gated panels gate the BODY as well as the button that opens them
[ ] A tile-holder with no view actions gets a message, not a blank page
[ ] An existing campusId/allowedClassIds check was ADDED to, not replaced
[ ] Verified: grant only `X.view` → tab read-only, siblings absent, API 403s directly
[ ] Verified: legacy role with the bridge capability still does everything
[ ] Verified: scoped user sees a filtered list and 404s on a foreign :id
[ ] Verified: SUPER_ADMIN unaffected
```

---

## 7. Tests

```bash
cd tafs-backend
npx jest src/common/scope src/common/guards src/modules/access src/modules/auth src/modules/hr/employees
npx nest build          # the real gate
```

50 specs cover the foundation: scope AND-ing / empty-is-unrestricted / null
exclusion, action defaults, `implies` expansion, reverse-implies denial, the
legacy bridge, denied tiles, SUPER_ADMIN bypass on both layers, and that every
key of `UpdateEmployeeDto` appears in `EMPLOYEE_FIELD_TAB_MAP` (add a DTO field
without mapping it and CI fails).

On the **webapp**: `npx tsc --noEmit` must be clean and `npm run build` must
compile. `npx eslint` carries a large pre-existing error count in these files
(46 in `studentwise-fees`, 177 across `identity/students`) — **diff it against
`git stash`, never read the absolute number.**

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
- **Unguarded writes** — `setUserAccess` / `ScopeService.setScope` blow up the
  whole save on an unmigrated DB. Client-side patch in place; fix before the
  next access-layer migration.
- **Access Packs cannot carry sub-permissions in the UI** — `listPacks` does
  not return `tileActions`, so the People & Access pack editor cannot show
  them. Widen that endpoint first.
- **Legacy scope helpers still stand** — `applyStudentScope` and the 12
  copies of `assertCampusAccess`. Removing them is rollout item 4 and must wait
  for tokens to rotate; see §5b.
- **The Employee Advanced form is not field-gated** — entrance-gated only; the
  API field-partitions behind it.
- **Scoping the admin panel itself** — should a campus-scoped admin be able to
  grant access outside their own scope? Currently yes. Probably wants to be no.
