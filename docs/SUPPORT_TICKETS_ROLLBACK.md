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

3. Deploy backend, webapp, and Flutter parent app together.

## Production hardening (implemented)

- **Backend:** FCM presence uses `family_app_{id}` (not staff in ticket room); `enterTicket` ACL; `PoliciesGuard` on staff routes; atomic forward; pagination caps; `closed_at` index; guardian opening message on create.
- **Webapp:** Redux thunks (mark-read, send, claim, transfer, forward, close, review); incremental socket updates; staff picker modals; permission page guard; Super Admin jump-to-ticket; media upload in thread.
- **Flutter:** Shared chat socket for tickets; FCM `SUPPORT_TICKET_MESSAGE` deep link; live unread badge; `ChatBubble` + `MessageInput` in thread; parent close query.

## E2E scenarios (manual)

| Scenario | Parent (Flutter) | Staff (Webapp) | Super Admin |
|----------|------------------|----------------|-------------|
| General + child | MCQ wizard → principal route | My Queue → reply | Approve |
| General no child | MCQ → General Respondent | My Queue / forward | Approve |
| Financial | MCQ → finance queue | Finance Queue → Claim → reply | Approve |
| Staff reply leak | Must NOT see PENDING | Send reply (PENDING) | Approve in queue |
| Reject | Never sees rejected text | Sees rejection reason | Reject with comment |
| Close | Close query button | Assignee closes | — |
| Permissions | — | Re-login after seed; nav visible | All Open tab |
| FCM | Tap notification → thread | — | — |

Test accounts: `muhammad.hussain.mirza`, `hira.khadim`, `nimla.asad`, `general.respondent` (passwords in `scripts/seed-staff-roster-credentials.csv` after roster seed).

## Rollback

- **UI only**: Revert webapp nav to `/chat` and Flutter app bar to `ChatPage`. Old chat tables/endpoints remain.
- **No data migration** required — tickets are additive.
- Announcements continue via `/chat` announcement channel and Notice Board.

## Cutover notes

- Webapp: **Support Tickets** is primary; **Announcements Chat** retains legacy broadcast path.
- Flutter: App bar opens **My Queries** (tickets); `ChatBloc` still runs for announcements socket path.
- Closed-ticket peer visibility uses **`routed_role`** (not close-time holder role).
