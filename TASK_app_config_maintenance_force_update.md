# Task: App Config — Force Update & Maintenance Mode

**Assignee:** Ashhal  
**Date:** 2026-06-02  

---

## Overview

Implement a centralised `app_config` table in the database that controls:

1. **Force update** — minimum required build numbers for Android and iOS. If the installed app build is below the minimum, the app shows a blocking "update required" screen.
2. **Maintenance mode** — a toggle that, when enabled, shows a blocking maintenance screen to all app users.

An admin panel **Developer** section (under the existing `/admin` route) lets authorised users manage these configs without a deployment.

---

## 1. Database — Prisma Schema

Add the following model to `tafs-backend/prisma/schema.prisma`:

```prisma
model app_config {
  id                      Int      @id @default(autoincrement())
  key                     String   @unique @db.VarChar(100)
  value                   String
  description             String?  @db.VarChar(255)
  updated_at              DateTime @updatedAt @db.Timestamp(6)
  updated_by              String?  @db.VarChar(255)
}
```

### Seed rows (add to the seed script or as a migration data script)

| key | value | description |
|-----|-------|-------------|
| `min_android_build` | `1` | Minimum Android build number required |
| `min_ios_build` | `1` | Minimum iOS build number required |
| `maintenance_mode` | `false` | Whether maintenance mode is active |
| `maintenance_message` | `The app is currently under maintenance. Please try again later.` | Message shown to users |

Run migration:
```bash
npx prisma migrate dev --name add_app_config
```

---

## 2. Backend — NestJS Module

Create `src/modules/app-config/` with the following structure:

```
app-config/
  app-config.module.ts
  app-config.controller.ts
  app-config.service.ts
```

### 2a. Service (`app-config.service.ts`)

Key methods:

```typescript
// Get all configs (admin)
getAllConfigs(): Promise<app_config[]>

// Get a single config by key
getConfig(key: string): Promise<app_config | null>

// Upsert a config value (admin only)
setConfig(key: string, value: string, updatedBy: string): Promise<app_config>

// Public endpoint payload — called by the app on launch
getAppStatus(platform: 'android' | 'ios', buildNumber: number): Promise<{
  maintenanceMode: boolean;
  maintenanceMessage: string;
  forceUpdate: boolean;
  minBuildNumber: number;
}>
```

### 2b. Controller (`app-config.controller.ts`)

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| `GET` | `/app-config/status?platform=android&build=42` | Public | App calls this on launch |
| `GET` | `/app-config` | `SUPER_ADMIN` | List all config keys |
| `PATCH` | `/app-config/:key` | `SUPER_ADMIN` | Update a config value |

The `/app-config/status` endpoint is unauthenticated — the Flutter app calls it before login screens are even shown.

### 2c. Status response shape

```json
{
  "maintenanceMode": false,
  "maintenanceMessage": "The app is under maintenance.",
  "forceUpdate": false,
  "minBuildNumber": 5
}
```

`forceUpdate` is `true` when `buildNumber < min_{platform}_build`.

---

## 3. Flutter App Integration

### 3a. On app launch (before home/login)

In the app's initialisation flow (likely in `main.dart` or a splash/bootstrap widget), call `GET /app-config/status` with the current platform and build number.

```dart
// Get current build number
final info = await PackageInfo.fromPlatform();
final buildNumber = int.parse(info.buildNumber);
final platform = Platform.isAndroid ? 'android' : 'ios';

final response = await apiClient.get(
  '/app-config/status',
  queryParams: {'platform': platform, 'build': buildNumber},
);
```

### 3b. Maintenance mode screen

If `maintenanceMode == true`, show a **non-dismissible** full-screen widget:

- School logo / branding
- Title: "Under Maintenance"
- Body: `maintenanceMessage` from the response
- No back navigation, no skip
- A "Retry" button that re-calls the status endpoint

### 3c. Force update screen

If `forceUpdate == true`, show a **non-dismissible** full-screen widget:

- Title: "Update Required"
- Body: "Please update the app to continue."
- A single CTA button: "Update Now" → opens Play Store / App Store deep link
- No back navigation, no skip

### 3d. Priority

Check **maintenance mode first**, then force update. Both should be checked before rendering any app content.

### 3e. Suggested location

The check fits cleanly in a `BootstrapScreen` or a `ProviderScope` observer that sits above the router. Whatever the current app equivalent is, gate navigation behind this check.

---

## 4. Admin Panel — Developer Section

### 4a. Route

Add a new page at:

```
tafs-webapp/app/(dashboard)/admin/developer/page.tsx
```

Add a nav link in the admin sidebar under a new **"Developer"** group.

### 4b. Access control

Restrict to `SUPER_ADMIN` only (same pattern as `/admin/permissions`).

### 4c. UI

A single settings page with two cards:

---

**Card 1 — App Version Control**

| Field | Input | Notes |
|-------|-------|-------|
| Min Android Build | Number input | Saves to `min_android_build` |
| Min iOS Build | Number input | Saves to `min_ios_build` |

"Save" button calls `PATCH /app-config/min_android_build` and `PATCH /app-config/min_ios_build`.

---

**Card 2 — Maintenance Mode**

| Field | Input | Notes |
|-------|-------|-------|
| Maintenance Mode | Toggle (on/off) | Saves to `maintenance_mode` |
| Maintenance Message | Textarea | Saves to `maintenance_message` |

Toggling ON shows a confirmation dialog: _"This will block all app users immediately. Continue?"_

"Save" button calls `PATCH /app-config/maintenance_mode` and `PATCH /app-config/maintenance_message`.

---

## 5. Acceptance Criteria

- [ ] `app_config` table exists in DB with the 4 seed rows
- [ ] `GET /app-config/status` returns correct `forceUpdate: true` when build is below minimum
- [ ] `GET /app-config/status` returns correct `maintenanceMode: true` when toggle is on
- [ ] Flutter app blocks on maintenance screen (non-dismissible) when maintenance mode is on
- [ ] Flutter app blocks on force update screen (non-dismissible) when build is below minimum
- [ ] Turning off maintenance mode in admin immediately unblocks the app on next retry
- [ ] `/admin/developer` page is only accessible to `SUPER_ADMIN`
- [ ] Changing min build number in admin causes old build to be blocked on next app launch

---

## 6. Out of Scope

- Per-campus maintenance mode (global only for now)
- Staged rollouts / percentage-based force updates
- In-app update APIs (Google Play In-App Updates / Apple SKStoreReviewRequest)
- Push notification on maintenance toggle

---

## Notes

- The `app_config` table uses a key-value pattern intentionally — new config keys can be added without schema migrations.
- The status endpoint must have a very low response time (it's on the critical path of every app launch). Consider caching with a short TTL (e.g. 30 seconds) at the service layer if needed.
- Build number refers to the **integer build number** (e.g. `versionCode` on Android, `CFBundleVersion` on iOS), not the semver version string.
