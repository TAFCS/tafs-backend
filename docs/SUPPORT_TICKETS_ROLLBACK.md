# Support Tickets — Rollback & Production Guide

## Deploy checklist

1. Apply migrations:
   ```bash
   cd tafs-backend
   npx prisma migrate deploy
   npx ts-node scripts/seed-permissions.ts
   npx ts-node scripts/seed-staff-roster.ts
   ```
   **Important:** Staff must **log out and back in** after `seed-permissions.ts` so JWT includes `communication.support_tickets.view`.

2. Verify backend:
   ```bash
   npm run build
   npm test -- support-ticket
   npm run verify:support-tickets
   ```
   Env for verify script:
   - `PARENT_ACCESS_TOKEN`, `FAMILY_ID`
   - `STAFF_USERNAME=general.respondent`, `STAFF_PASSWORD` (from `seed-staff-roster-credentials.csv`)
   - `SUPER_ADMIN_USERNAME=muhammad.hussain.mirza`, `SUPER_ADMIN_PASSWORD`

3. Deploy backend, webapp, and Flutter app (parent + staff dual login) together.

## Production hardening (implemented)

### Backend
- FCM presence uses `family_app_{id}`; `enterTicket` ACL; `PoliciesGuard` on staff routes
- Atomic claim/transfer/forward; pagination caps; `closed_at` index
- Guardian opening message on ticket create
- **Parent event timeline filtered** — parents only see `CREATED`, `CLOSED_BY_STAFF`, `CLOSED_BY_PARENT` events
- **Atomic approval** — concurrent Super Admin reviews use `updateMany` on `PENDING` status
- Pending approvals list capped at 50 per request

### Webapp (staff)
- Redux thunks with `rejectWithValue` API errors; split `queueError` / `detailError` / `actionError`
- Stale thread cleared on ticket switch; close ticket sends `note` (not `comment`)
- UI aligned with Announcements Chat + HR: `Loader2` spinners, rose error banners, reconnect banner, HR modals
- Role-based page access (`canViewSupportTickets`); auth hydration on refresh
- Super Admin per-item approval loading; read-only banner for non-assignees

### Flutter (parent)
- Single `TicketThreadCubit` lifecycle; web-safe media upload
- Send appends API response (no full reload); friendly error messages + retry
- Themed list cards, origination load/submit errors, in-app notification on ticket socket when not in thread
- FCM `SUPPORT_TICKET_MESSAGE` deep link; live unread badge on app bar

### Flutter (staff — dual login)
- Login screen **Parent | Staff** tabs; staff uses ERP username (not parent email)
- `POST /auth/staff/mobile/login` + `/auth/staff/mobile/refresh` (Bearer tokens, no cookies)
- Staff session stored separately (`CACHED_STAFF`); parent and staff sessions are mutually exclusive
- `AuthAuthenticatedStaff` → `StaffMainShell` (skips student selection)
- Role-gated queue tabs mirror web: My Queue, Finance (FINANCE_CLERK / SUPER_ADMIN), All Open (SUPER_ADMIN), Closed
- Thread actions: claim, transfer, forward, close, Super Admin inline approve/reject on PENDING messages
- Staff must **re-login** after `seed-permissions.ts` so JWT includes `communication.support_tickets.view`

### Flutter (staff — announcements chat)
- Bottom nav **Tickets | Announcements** when staff has both `communication.support_tickets.view` and `communication.view_chats`
- Announcements tab: Official channel only (`GET /chat/history/admin/0`, socket `sendAnnouncement`)
- Grade/section targeting via `GET /classes` + `GET /sections` (same as web `AnnouncementSelectors`)
- Socket-only send — offline banner disables composer (no REST fallback)
- Roles with announcements only (no tickets): single Announcements screen
- FINANCE_CLERK / GENERAL_RESPONDENT: tickets tab only (no announcements)

## Automated verify script checks

`npm run verify:support-tickets` validates:
- Parent socket/REST do not leak PENDING staff messages before approval
- Parent event timeline excludes internal workflow events
- Approve flow delivers APPROVED message to parent REST
- Reject flow hides rejected message and reject/submit events from parent
- Mark-read succeeds

## E2E scenarios (manual)

| Scenario | Parent (Flutter) | Staff (Web / Flutter) | Super Admin |
|----------|------------------|----------------|-------------|
| General + child | MCQ wizard → principal route | My Queue → reply | Approve |
| General no child | MCQ → General Respondent | My Queue / forward | Approve |
| Financial | MCQ → finance queue | Finance Queue → Claim → reply | Approve |
| Staff reply leak | Must NOT see PENDING | Send reply (PENDING) | Approve in queue |
| Reject | Never sees rejected text | Sees rejection reason | Reject with comment |
| Close | Close query button | Assignee closes (note in modal) | — |
| Permissions | — | Re-login after seed; refresh page OK | All Open tab |
| Stale thread | — | Switch tickets rapidly — no wrong thread | — |
| Offline | — | Disconnect socket → banner + disabled composer | — |
| FCM | Tap notification → thread | — | — |

Test accounts: `muhammad.hussain.mirza`, `hira.khadim`, `nimla.asad`, `general.respondent` (passwords in `scripts/seed-staff-roster-credentials.csv` after roster seed).

### Flutter staff login (manual matrix)

| Account | Role | Expected in Flutter |
|---------|------|---------------------|
| `general.respondent` | GENERAL_RESPONDENT | My Queue → assigned ticket → send pending reply (no Announcements) |
| `nimla.asad` | FINANCE_CLERK | Finance Queue → claim → reply (no Announcements) |
| `muhammad.hussain.mirza` | SUPER_ADMIN | All Open + approval queue → approve inline |
| `hira.khadim` | PRINCIPAL | Tickets + Announcements tabs; send grade-targeted broadcast |
| Parent account | — | Parent tab → unchanged parent flow |

## Rollback

- **UI only**: Revert webapp nav to `/chat` and Flutter app bar to `ChatPage`. Old chat tables/endpoints remain.
- **No data migration** required — tickets are additive.
- Announcements continue via `/chat` announcement channel and Notice Board.

## Cutover notes

- Webapp: **Support Tickets** is primary; **Announcements Chat** retains legacy broadcast path.
- Flutter: App bar opens **My Queries** (tickets); `ChatBloc` still runs for announcements socket path.
- Closed-ticket peer visibility uses **`routed_role`** (not close-time holder role).
