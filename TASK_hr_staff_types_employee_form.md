# Task: Staff Types Page + New Employee Form (with photo upload)

**Date:** 2026-06-08

---

## Context

The backend now has (see prior work in `tafs-backend`):
- `staff_types` table + full CRUD module at `/v1/hr/staff-types` (`StaffTypesController`/`StaffTypesService`)
- `employee_profiles` extended with: `employee_code`, `full_name`, `father_name`, `mother_name`, `date_of_birth`, `address`, `personal_phone`, `personal_email`, `job_title`, `job_description`, `notes`, `reporting_time`, `leaving_time`, `late_relaxation_minutes`, `monthly_pay`, `staff_type_id`, `campus_id`, `days_per_week`
- `employee_class_section_assignments` join table (employee ↔ class ↔ section, for the `6:A,B;7:A,C` style assignment)
- `EmployeesService.create`/`update` already accept a `class_section_assignments: { class_id, section_id }[]` array and persist it transactionally

None of this has UI yet. We need two pages:
1. A staff-types management page (simple admin-editable lookup, same idea as `/hr/departments`)
2. An "Add/Edit Employee" form covering every field above, including a profile photo

---

## Page 1 — Staff Types (`/hr/staff-types`)

### Pattern to follow
Model this directly after `app/(dashboard)/hr/departments/page.tsx` (modal-based CRUD over a flat list) — staff types have no nesting, so it's actually simpler than departments (skip the designation sub-list).

### What to build
- New route: `app/(dashboard)/hr/staff-types/page.tsx` + `layout.tsx` (title: "Staff Types")
- List view: simple table/list showing `name`, `code`, `description`, `is_active` badge, with Edit (pencil) / Delete (trash) actions
- "Add Staff Type" button opens a modal with fields: `code` (text, required — explain it's the internal key e.g. `domestic`), `name` (text, required), `description` (textarea, optional), `is_active` (toggle/checkbox)
- Reuse the same loading/success/error/toast conventions as `departments/page.tsx`
- Add nav entry in `components/layout/profile-drawer.tsx` near the other HR links (e.g. `{ name: 'Staff Types', href: '/hr/staff-types', icon: Tag, permission: 'hr.employees.view' }`) — reuse the existing `Employee` CASL permission since the backend guards with `Action.Manage/Read 'Employee'`

### Service layer additions (`src/lib/hr.service.ts`)
Add a `StaffType` interface and CRUD methods, mirroring the `Department` block:
```ts
export interface StaffType {
  id: number;
  code: string;
  name: string;
  description: string | null;
  is_active: boolean;
}
// listStaffTypes / getStaffType / createStaffType / updateStaffType / deleteStaffType
// hitting GET/POST/PATCH/DELETE /v1/hr/staff-types[/:id]
```

---

## Page 2 — Add/Edit Employee (`/hr/employees/new` and edit flow)

### Current state
`app/(dashboard)/hr/employees/page.tsx` already has a list + a small modal covering only `user_id, cnic, join_date, employment_type, department_id, designation_id, reporting_manager_id`. That modal is too small for ~25 fields plus a photo — **convert employee creation/editing into its own dedicated page** (not a modal), e.g. `app/(dashboard)/hr/employees/new/page.tsx` and `app/(dashboard)/hr/employees/[id]/edit/page.tsx`, and change the "Add Employee" button on the list page to navigate there instead of opening the modal. Keep the existing list page as-is otherwise.

### Form sections & fields
Group the ~25 fields into clear sections (use card/section dividers, similar visual language to the student profile tabs):

**1. Photo**
- `PhotoUpload`-style component at the top (see Photo Upload section below)

**2. Personal Information**
- `full_name` (text, required)
- `father_name` (text)
- `mother_name` (text)
- `cnic` (text, required, format `XXXXX-XXXXXXX-X` — reuse existing CNIC formatting/validation if the student form has one)
cnic mein dash hone chahiyen on frontend pehle se
- `date_of_birth` (date picker, optional)
- `address` (textarea)
- `personal_phone` (text, optional)
- `personal_email` (email, optional)

**3. Employment Details**
- `employee_code` (text, required, unique — explain "assigned by school") give next available ideally 
- `staff_type_id` (dropdown, populated from `hrService.listStaffTypes()`, required)
- `department_id` → `designation_id` (dependent dropdowns, same pattern as the existing employee modal)
- `job_title` (text)
- `job_description` (textarea, optional)
- `join_date` (date picker)
- `reporting_manager_id` (dropdown of existing employees)
- `campus_id` (dropdown — fetch via existing campuses service)
- `notes` (textarea, optional)

**4. Work Schedule & Pay**
- `reporting_time` / `leaving_time` (time pickers, `HH:MM`)
- `late_relaxation_minutes` (number input, minutes)
- `days_per_week` (select: 5 or 6)
- `monthly_pay` (number input, PKR, required)

**5. Class–Section Assignment** (only relevant/shown for `staff_type = teacher`, but keep it generic)
- A repeatable row UI: pick a `class_id` (dropdown from existing classes service) then multi-select `section_id`s for that class
- Internally builds the `class_section_assignments: { class_id, section_id }[]` array the backend already accepts
- "+ Add another class" button to add more rows; each row removable
- This directly maps to the spreadsheet's `6:A,B;7:A,C` notation — no need to expose raw text syntax to the user, build it from dropdowns

 fetched from campus_classes and campus_sections, wahan premade classes aur sectins hein 

**6. Account Link** (optional, existing behavior)
- Keep the existing `user_id` linking dropdown (from `hrService.getUnlinkedUsers()`) — for staff who need a login
all staff needs a login, bhale wo domestic hi kyun na ho, sabke bana do 

### Submit behavior
- On create: `hrService.createEmployee(payload)` where payload includes all scalar fields + `class_section_assignments`
- On edit: prefill from `hrService.getEmployee(id)` (note: service needs to request the new relations — see service layer note below), then `hrService.updateEmployee(id, payload)`
- After successful create, if a photo was selected before the employee existed, upload it now (employee photo upload needs an `employee_id`, so: create employee first → then upload photo using the returned `id`). On edit, photo can be uploaded immediately since `id` is known.
- Validate required fields client-side before submit (full_name, cnic, employee_code, staff_type_id, monthly_pay) — mirror existing form validation patterns

### Service layer additions (`src/lib/hr.service.ts`)
- Extend `EmployeeProfile` interface with all the new scalar fields, plus:
  ```ts
  staff_types?: StaffType | null;
  campuses?: { id: number; campus_name: string } | null;
  employee_class_section_assignments?: { class_id: number; section_id: number; classes?: {...}; sections?: {...} }[];
  ```
- Extend `createEmployee`/`updateEmployee` payload typing to include `class_section_assignments`

---

## Photo Upload (new bucket folder)

### Backend changes needed (in `tafs-backend`)
Follow the exact pattern in `MediaService.uploadGuardianPhoto` / `MediaController`:

1. **Schema**: add a `photo_url String?` column to `employee_profiles` (small follow-up migration — wasn't in the original field list but is required to store the uploaded image URL)
2. **Storage folder**: new key prefix `media/employees/{id}/profile-{timestamp}.{ext}` in the existing DigitalOcean Spaces bucket (`StorageService` — no new bucket needed, just a new key prefix/"folder", consistent with `media/students/{cc}/` and `media/guardians/{id}/`)
3. **Endpoint**: add `POST /v1/media/employee/:id/photo` to `MediaController`, and `uploadEmployeePhoto(id, file)` to `MediaService`:
   ```ts
   async uploadEmployeePhoto(id: number, file: Express.Multer.File) {
     const employee = await this.prisma.employee_profiles.findUnique({ where: { id } });
     if (!employee) throw new NotFoundException(...);
     const extension = file.originalname.split('.').pop() || 'jpg';
     const key = `media/employees/${id}/profile-${Date.now()}.${extension}`;
     const url = await this.storage.upload(key, file.buffer, file.mimetype);
     await this.prisma.employee_profiles.update({ where: { id }, data: { photo_url: url } });
     return { url };
   }
   ```

### Frontend
- Reuse/adapt `PhotoUpload.tsx` — add an `employeeId?: number` prop and a third branch:
  ```ts
  } else if (employeeId) {
    endpoint = `/v1/media/employee/${employeeId}/photo`;
  }
  ```
- Place it at the top of the employee form; disable/hide until the employee record exists (i.e. only show after first save when creating new)

---

## Migration checklist (backend, before/alongside frontend work)

1. Add `photo_url String?` to `employee_profiles` in `schema.prisma` + a small migration (`ALTER TABLE employee_profiles ADD COLUMN IF NOT EXISTS photo_url TEXT;`)
2. Add `uploadEmployeePhoto` to `MediaService` and `POST employee/:id/photo` to `MediaController`
3. Run `npx prisma migrate deploy` (note: last attempt failed with `P1001` — DB host unreachable from this machine; run from an environment with DB access) + `npx prisma generate`

---

## Summary of new/changed files

| File | Change |
|---|---|
| `tafs-backend/prisma/schema.prisma` | add `photo_url` to `employee_profiles` |
| `tafs-backend/prisma/migrations/<ts>_add_employee_photo_url/migration.sql` | new migration |
| `tafs-backend/src/modules/media/media.service.ts` | add `uploadEmployeePhoto` |
| `tafs-backend/src/modules/media/media.controller.ts` | add `POST employee/:id/photo` route |
| `tafs-webapp/src/lib/hr.service.ts` | add `StaffType` interface + CRUD methods; extend `EmployeeProfile` with new fields/relations |
| `tafs-webapp/app/(dashboard)/hr/staff-types/page.tsx` (+ `layout.tsx`) | new staff types CRUD page |
| `tafs-webapp/app/(dashboard)/hr/employees/new/page.tsx` | new "Add Employee" full-form page |
| `tafs-webapp/app/(dashboard)/hr/employees/[id]/edit/page.tsx` | new "Edit Employee" page (or share component with `new`) |
| `tafs-webapp/app/(dashboard)/hr/employees/page.tsx` | change "Add Employee" button to navigate to `/hr/employees/new`; remove/replace the now-too-small modal |
| `tafs-webapp/app/(dashboard)/identity/students/tabs/PhotoUpload.tsx` | extend with `employeeId` prop (or copy into a shared `components/` location if preferred) |
| `components/layout/profile-drawer.tsx` | add "Staff Types" nav entry |
