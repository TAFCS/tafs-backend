# Universal Scope + Tile Sub-Permissions — starting with Employee Directory

## Context

The tile layer shipped: `tiles.manifest.ts` defines ERP tiles, `access_packs` / `user_tile_grants`
layer additively on top of `role_permissions`, and `computeEffectiveAccess` resolves it all into
the capability-key array the JWT already carried. That answers *"which tiles can this person see."*

It does not answer the two questions the business actually hits next:

1. **"What can they DO inside a tile?"** Employee Directory is one tile with **~25 backend routes
   that collapse to exactly two checks** — `Read Employee` and `Manage Employee`
   (`tafs-backend/src/modules/hr/employees/employees.controller.ts`). Editing a phone number,
   changing salary, deleting an employee, and revealing a portal password are all the same
   permission today. The detail panel already has 10 tabs
   (`tafs-webapp/app/(dashboard)/hr/employees/_components/EmployeeDetailPanel.tsx`, `BASE_TABS`)
   with no way to grant one without the rest.

2. **"Which records can they touch?"** Scope enforcement is ad-hoc and mostly absent:
   - `private assertCampusAccess(user, campusId)` is **copy-pasted into 12 services** (attendance ×6,
     hr/leaves, hr/payroll, hr/saturday-schedules, hr/shift-overrides, timetables ×2), each one
     re-implementing `if (user.campusId && user.campusId !== campusId) throw`.
   - `allowedClassIds` is read in only 5 places (roll-sessions, student-attendance, students, analytics ×2).
   - **Segments and sections have no scoping anywhere.**
   - `EmployeesService.findAll()` has **no scoping at all** — it returns every employee at every
     campus, and the controller never passes the caller. A Johar-only user sees all three campuses.

These are two orthogonal layers and are built as such:

```
          WHAT you may do                    WHICH records you may do it to
        ┌────────────────────┐             ┌──────────────────────────────┐
        │ tile sub-permission│      ×      │  universal scope ("can touch")│
        │  hr.employee_       │             │  campuses / segments /        │
        │  directory#         │             │  classes / sections /         │
        │  schedule_pay.edit  │             │  departments / categories     │
        └────────────────────┘             └──────────────────────────────┘
                        both must pass, for every request
```

### Decisions taken (from clarification)

- **Scope shape: flat per-dimension lists, AND-ed.** One scope per user; empty list on a dimension
  means unrestricted there; a record must match every non-empty dimension.
- **Single scope = full CRUD.** No separate view-scope vs edit-scope. Outside your scope a record
  does not exist for you: filtered out of lists, 403 on direct access.
- **Sub-permissions at tab + action level.** Per-tab view/edit pairs plus discrete actions. No
  field-level flags for now.
- **New scope replaces `users.campus_id` and `allowed_class_ids`**, with the data migrated over and
  all call sites rewritten onto one shared helper.

---

## Part A — Universal scope

### Schema (`tafs-backend/prisma/schema.prisma`)

```prisma
enum ScopeDimension { CAMPUS SEGMENT CLASS SECTION DEPARTMENT STAFF_CATEGORY }

model user_scope_entries {
  user_id   String
  dimension ScopeDimension
  ref_id    Int
  user      users @relation(fields: [user_id], references: [id], onDelete: Cascade)
  @@id([user_id, dimension, ref_id])
  @@index([dimension, ref_id])
}
```

Normalized rather than array columns so a new dimension is a enum value, not a migration of every row.

### Shared helper — `tafs-backend/src/common/scope/` (new)

This is the piece that kills the 12 duplicated `assertCampusAccess` methods.

- `scope.types.ts` — `type UserScope = { campuses: number[]; segments: number[]; classes: number[]; sections: number[]; departments: number[]; staffCategories: number[] }`. Empty array = unrestricted.
- `scope.service.ts` —
  - `resolve(userId): Promise<UserScope>` (called at login/refresh, cached into the session payload).
  - `assertCampus(user, campusId)` / `assertSegment` / `assertClass` / `assertSection` — throw `ForbiddenException` when the dimension is non-empty and the id is not in it. **SUPER_ADMIN always passes.**
  - `whereForEmployees(scope)` → Prisma fragment `{ campus_id: {in}, segment_id: {in}, department_id: {in}, staff_category_id: {in} }`, omitting any dimension whose list is empty.
  - `whereForStudents(scope)` → same idea over `campus_id` / `class_id` / `section_id`.
- Register as a global provider so services inject it instead of hand-rolling.

### Session payload

`UserScope` joins `permissions` in the login/refresh response and `IJwtStaffPayload`
(`auth.service.ts` `loginStaff` + `refreshStaffToken`, `jwt-payload.interface.ts`,
`jwt-staff.strategy.ts`). Frontend `StaffUser` (`tafs-webapp/src/store/slices/authSlice.ts`) carries
it so the UI can pre-filter dropdowns to the scoped campuses/segments rather than offering choices
the API will reject.

### Migration off the old fields

1. Backfill: each `users.campus_id` → one `CAMPUS` entry; each `allowed_class_ids` element → a `CLASS` entry.
2. Rewrite the **12 `assertCampusAccess` copies** to call `scope.assertCampus(user, id)` and delete
   the private methods. Rewrite the **5 `allowedClassIds` readers** to use `scope.classes`.
3. Keep `users.campus_id` / `allowed_class_ids` **written-through but unread** for one release
   (nothing reads them once step 2 lands), then drop both columns in a follow-up migration.
   `users.campus_id` carries an FK to `campuses` and appears in several `select` blocks
   (`users.service.ts`), so dropping it is its own reviewed change — do not bundle it here.

---

## Part B — Tile sub-permissions

### Manifest extension — `tafs-backend/src/modules/access/tiles.manifest.ts`

```ts
export type TileAction = {
  id: string;            // 'profile.view' | 'profile.edit' | 'delete'
  label: string;
  description?: string;
  default?: boolean;     // granted automatically when the tile itself is granted
  implies?: string[];    // 'profile.edit' implies 'profile.view'
};
export type TileManifestEntry = { /* ...existing... */ actions?: TileAction[] };
```

A tile with no `actions` behaves exactly as today. Addressing is `tileId#actionId`, e.g.
`hr.employee_directory#schedule_pay.edit`.

### Schema — three sibling tables mirroring the tile ones

- `access_tile_actions` — `tile_id`, `action_id`, `label`, `description`, `is_default`, `sort_order`. Owned by `AccessSync` (upsert from manifest, deactivate missing), same as `access_tiles`.
- `access_pack_tile_actions` — `pack_id`, `tile_id`, `action_id`.
- `user_tile_action_grants` — `user_id`, `tile_id`, `action_id`, `allow`, `granted_by`, `granted_at`, `note`.

### Resolver — `access.effective.ts`

`computeEffectiveAccess` gains `actionIds: string[]` alongside `capabilityKeys` / `tileIds`:

- A granted tile confers its `default: true` actions only.
- Pack action grants and user action grants union on top; `implies` expands transitively.
- A denied tile removes all of its actions.
- A user-level `allow: false` on an action beats every grant.
- **SUPER_ADMIN gets every action.**
- **Legacy bridge (critical for not breaking day one):** a user holding a tile's underlying *edit*
  capability from `role_permissions` — e.g. `hr.employees.edit` — is granted **all** actions of the
  tiles that capability backs. Existing users therefore behave identically until an admin
  deliberately narrows them. This bridge is removed only once every legacy role has been re-expressed
  as packs.

`AccessService.resolveEffective` passes the new rows through; `getUserAccess` / `setUserAccess` and
`SetUserAccessDto` (`dto/access.dto.ts`) gain `actionGrants: {tileId, actionId, allow, note?}[]` and
`CreateAccessPackDto` / `UpdateAccessPackDto` gain `tileActions: {tileId, actionId}[]`.

### Enforcement — new decorator

`@RequireAction('hr.employee_directory#delete')` plus a `TileActionGuard`, sitting alongside the
existing `PoliciesGuard` rather than replacing it. CASL keeps guarding the coarse layer; the new
guard adds the fine one. Both must pass.

---

## Part C — Employee Directory, the first subject

### Sub-permissions

Tabs (each a `view` / `edit` pair), matching `BASE_TABS` in `EmployeeDetailPanel.tsx`:

| action id | tab |
|---|---|
| `profile.view` / `.edit` | Profile |
| `employment.view` / `.edit` | Employment |
| `schedule_pay.view` / `.edit` | Schedule & Pay (incl. `monthly_pay`, work schedule, increment cycle) |
| `security_deposit.view` / `.edit` | Security Deposit |
| `loan.view` / `.edit` | Loan |
| `classes.view` / `.edit` | Class & Sections |
| `progression.view` / `.edit` | Progression |
| `portal.view` / `.edit` | Portal Account |
| `biometric.view` / `.edit` | Biometric |
| `shift_overrides.view` / `.edit` | Shift Overrides |

Discrete actions: `view` (`default: true`, the directory list itself), `create`, `delete`,
`status.change` (ACTIVE/PERMANENT/FAMILY/LEFT/TERMINATED), `portal.reveal_password`,
`portal.reset_password`, `portal.change_username`, `export`.

### Route map (`employees.controller.ts`)

| route | required action |
|---|---|
| `GET /`, `GET /:id`, `GET /search-simple`, `GET /unlinked-users`, `GET /next-code` | `view` |
| `GET /export`, `GET /export-master-excel` | `export` |
| `POST /` | `create` |
| `DELETE /:id` | `delete` |
| `PATCH /:id/status` | `status.change` |
| `PATCH|DELETE /:id/work-schedule`, `PATCH /:id/increment-cycle` | `schedule_pay.edit` |
| `GET /:id/salary-increment*`, `GET /:id/progression` | `schedule_pay.view` / `progression.view` |
| `PATCH /:id/account`, `POST /:id/account/reset-password`, `PATCH /:id/account/username` | `portal.edit` + the specific action |
| `GET /:id/account/reveal-password` | `portal.reveal_password` |
| `POST /:id/previous-employers`, `DELETE /previous-employers/:id` | `profile.edit` |

**`PATCH /:id` needs field partitioning.** It is one route that writes fields belonging to several
tabs. Add a `FIELD_TAB_MAP` in the employees module mapping every `UpdateEmployeeDto` field to its
owning tab, then reject the request naming the offending fields if the caller lacks that tab's
`.edit`. Do not let a broad PATCH become a hole around the tab permissions.

### Scope enforcement

- `EmployeesService.findAll(summary, user)` — thread the caller through from the controller (it is
  not passed today) and merge `scope.whereForEmployees(scope)` into the `where`. Same for
  `searchSimple`, `export`, `export-master-excel`.
- `findOne` / every `:id` route — load the employee's `campus_id`, `segment_id`, `department_id`,
  `staff_category_id` and run the scope assertions before acting. Out of scope → 404, not 403, so
  the directory cannot be used to enumerate employees at other campuses.
- `create` — reject when the target campus/segment/department falls outside the creator's scope.

### Frontend

- `useEmployeeAccess()` hook over the effective-actions list: hides tabs the user cannot
  `*.view`, renders them read-only without `*.edit`, and hides Create / Delete / status /
  reveal-password / Export controls.
- Campus, segment, department and category pickers across
  `app/(dashboard)/hr/employees/` filter to the session scope.

---

## Panel UX (`tafs-webapp/app/(dashboard)/system/`)

- **People & Access drawer** gains a **Scope** tab — six multi-selects (Campuses, Segments, Classes,
  Sections, Departments, Staff Categories), each showing **"All"** when empty, with a plain-language
  summary line ("Academics staff in Secondary at Johar and North Nazimabad").
- **Access tab**: each tile row becomes expandable, revealing its sub-permissions from the live
  catalog with the same tri-state (inherited / allowed / denied) already used for tiles.
- **Access Packs editor** (`system/permissions/page.tsx`): the same expansion, so a pack can carry
  *Employee Directory → view + profile.edit* without payroll or delete.
- `use-access-catalog.ts` returns `actions` per tile; no other frontend fetch changes.

---

## Rollout order

1. **Scope infra** — schema, `ScopeService`, backfill, session payload, rewrite the 12 + 5 call sites.
2. **Employee Directory scoping** — thread the caller through `findAll` and the `:id` routes.
   *Immediately visible win: campus-scoped users stop seeing all three campuses.*
3. **Sub-permission infra** — manifest `actions`, three tables, `AccessSync`, resolver, DTOs, guard.
4. **Employee Directory sub-permissions** — route map, `FIELD_TAB_MAP`, panel UI.
5. Repeat step 4's pattern per tile, highest-risk tiles first (Payroll, Vouchers, People & Access).

Steps 1–2 and 3–4 are independently shippable.

## Verification

1. **No regression:** for a sample of each legacy role, effective `capabilityKeys` is byte-identical
   before/after; a user with `hr.employees.edit` still reaches every tab (legacy bridge).
2. **Scope backfill:** every user with a `campus_id` gets exactly one `CAMPUS` entry; every
   `allowed_class_ids` element becomes a `CLASS` entry; count-match assertion in the migration script.
3. **Scope bites:** scope a user to Johar → `GET /hr/employees` returns only Johar employees;
   `GET /hr/employees/:id` for a North Nazimabad employee returns 404; the campus picker offers only Johar.
4. **Empty = unrestricted:** a user with zero scope entries sees exactly what they see today.
5. **Sub-permission grant:** grant *Employee Directory → view + profile.edit* only → Profile tab
   editable, Schedule & Pay read-only, Security Deposit/Loan/Portal tabs absent, Delete and
   Export hidden; the corresponding API calls 403 when invoked directly.
6. **Field partitioning:** `PATCH /hr/employees/:id` carrying `monthly_pay` from a caller holding only
   `profile.edit` is rejected and names the offending field.
7. **Denial precedence:** a user-level `allow:false` on `delete` beats a pack that grants it.
8. **SUPER_ADMIN** is unaffected by both layers.
9. Unit specs beside the existing `access.effective.spec.ts` for action resolution (defaults,
   `implies`, deny precedence, legacy bridge) and a new `scope.service.spec.ts` (AND-ing,
   empty-dimension, super-admin bypass).
