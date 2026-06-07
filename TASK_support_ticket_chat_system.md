# Task: MCQ-Driven Support Ticket System (Replaces Parent Chat)

**Assignee:** TBD  
**Date:** 2026-06-07  

---

## Context

Today, a parent's "chat" is one permanent open-ended thread per family (`chat_conversations` is hard-capped at one row per family via `family_id Int? @unique`), landing in a generic admin inbox with no routing, no ownership, and no quality control. `chat_messages.status` already has a `MessageStatus` enum (`PENDING`/`APPROVED`/`REJECTED`) defined in the schema but it's never used — every message defaults to and stays `APPROVED`.

This task replaces that with a structured **query/ticket system**: parents declare what they need via a short questionnaire, the system routes the query to the *right specific person* (not a generic inbox), every staff reply is quality-checked by a Super Admin before the parent ever sees it, and once resolved, the record becomes part of a shared institutional history that the right people can review later.

This **fully replaces** the existing single-thread chat. Announcements (the `is_announcement`/`target_grade`/`target_section` broadcast mechanism in `chat_messages`) are a separate thing and are NOT touched — they keep working exactly as today.

---

## 1. The Flow (end-to-end)

### 1.1 Opening "Chat"
The parent lands on a list of their **open tickets** — they may have several at once (e.g. one open General query about one child *and* one open Financial query simultaneously; these route to entirely different people, so there's no reason to force one-at-a-time). A persistent **"Raise a new query"** action always starts the questionnaire. Closed tickets live in a separate read-only "history" view.

### 1.2 The questionnaire
1. **Category** — General or Financial
2. **Which child** — picked from the family's children, or "not about a specific child" (this materially changes routing only for General; for Financial it's just context for the clerk pulling up records)
3. **Topic** — a short contextual picklist that varies by the answers above (see §2) — gives the responder triage context immediately
4. **Free-text description** — required, minimum length enforced. MCQs alone can't capture "my March voucher shows the wrong amount" — and because every reply now needs Super Admin approval, clarification round-trips are expensive, so the more context captured up front, the better.

### 1.3 Routing — where each ticket goes and why

| Scenario | Destination | Mechanism |
|---|---|---|
| **General**, specific child picked | The one Principal whose scope covers that child | Deterministic, automatic lookup against `users.campus_id` + `users.allowed_class_ids`. Check **campus-wide principals first** (empty `allowed_class_ids` — e.g. Samia Abbas → "Scheme 33" campus, Ferwa Sabir → "NNN" campus), **then class-band principals** (e.g. Sukaina Osama=PN-KG, Lana=Jr I-II, Anita=Jr III-V, Sara Naqvi=Sr I-III, Hira Khadim=VI-X, Syed Komail Hassan=O/A — all at the main campus). This is "the normal case" — it needs no new assignment data, just a lookup function over data that already exists. |
| **General**, "not about a specific child" | A brand-new **General Respondent** role (one dedicated login) | Their whole job is triage: read it, answer directly, or **forward it to anyone** — a principal, a finance clerk, Campus Admin, or Super Admin. Forwarding hands over sole ownership AND the obligation to close (see §1.5). |
| **Financial** (any) | A **shared queue visible to all 3 finance clerks** (Fozia Hussain, Nimla Asad, Mrs. Adil) | Nobody is auto-assigned — by explicit decision, NOT round-robin/load-balancing. It sits "unclaimed" and visible to all three; whoever taps **"Claim"** first becomes sole responder. The other two can still see it (so they know it's handled) but cannot post — *unless* the claimant **transfers** it to one of them. |

**Race-safety note for claiming**: two clerks could tap "Claim" at the same instant. Handle this with an atomic conditional update — `UPDATE support_tickets SET current_assignee_id = :clerk WHERE id = :id AND current_assignee_id IS NULL` inside a transaction. Postgres guarantees only one such update can succeed; `rowsAffected === 0` unambiguously means "someone beat you to it" (no version columns or app-level locks needed).

### 1.4 Replying — the Super Admin approval gate
Identical rule for **every** responder role (Principal, Finance Clerk, General Respondent — anyone replying to a parent):

1. Staff writes a reply → saved with status **PENDING**. The parent sees **nothing** — not even a "typing" hint — until it clears review. (No side effects fire yet: no unread-count bump, no push notification, no socket broadcast to the parent's room. This "don't leak a pending message through any side channel" property is the trickiest correctness requirement in the whole feature.)
2. It lands in a **Super Admin review queue**, visible in real time to all 3 super admins.
3. **Approve** → message instantly delivers to the parent (push + live update); responder is told it went through.
   **Reject** (with a short reason, mirroring `parent_change_requests`' `comment`/`processed_by` fields) → parent never sees it; responder sees the rejection reason and can revise and resend.
4. This repeats for **every message** in the thread, not just the first reply.

> Operational flag (not a design objection): since this gates *every* reply in *every* ticket, ticket volume becomes Super-Admin-queue volume directly. Worth watching as usage ramps up — if it bottlenecks, this is the natural place to revisit (e.g. gate first-replies only). Nothing to change now.

### 1.5 Claiming, transferring, forwarding
- **Finance claim**: first-to-claim becomes sole responder; the other two go read-only in that ticket.
- **Finance transfer**: only the *current* responder can transfer, and only to one of the other two finance clerks. Recipient becomes the new sole responder; the audit trail records the handoff.
- **General Respondent forward**: broader power — can hand off to *any* staff member of *any* role. Recipient becomes sole responder and inherits the close obligation.
- **Suggested consistency rule** (not covered by the original spec, but falls out naturally): once forwarded to, say, a Principal, that Principal can transfer onward only to *another Principal* — normal responders hand off within their own peer group; only the General Respondent has the cross-role "send to anyone" power. Keeps the rules simple and symmetric — flag if broader re-forwarding is wanted instead.

### 1.6 Closing
- The **responder** is responsible for closing once resolved.
- The **parent** can close at any time if satisfied or no longer needing a reply.
- Closed = done, no "reopen." A later follow-up (even on the same topic) goes through the questionnaire again as a new ticket. (A "reopen" escape hatch is a clean v2 addition if it turns out to be needed — not proposed now.)

### 1.7 After closing — hierarchical visibility
Rule to implement: *a closed ticket and its full history become visible to "the same level and the levels above."* Concretely:

```
Level 3 (top):        SUPER_ADMIN          — sees everything anyway (approves every reply)
Level 2 (oversight):  CAMPUS_ADMIN         — sees every closed ticket, any category
Level 1 (responders): PRINCIPAL ◄┐
                      FINANCE_CLERK ◄┤ — peers see each other's CLOSED tickets within their OWN role group only
                      GENERAL_RESPONDENT ◄┘   (a finance clerk does NOT see closed Principal tickets, etc.)
```
- **While OPEN**: visible only to the current responder (+ Super Admin via the approval queue). No peer or Campus Admin visibility on active tickets — that would just create cross-talk.
- **Once CLOSED**: full read-only history opens to the responder's peers, Campus Admin, and Super Admin — a shared institutional record (consistency checks, training, "how was this answered before").
- **Open question to confirm before building** (see §8.1): if a ticket was *forwarded* across role lines (e.g. General Respondent → a Principal who closes it), should peer-visibility key off the role it was *originally routed to*, or the role of *whoever was holding it at closing*? Recommendation: key off whoever was holding it at close — that's the version of "same level" that means something once role lines get crossed.

---

## 2. MCQ Questionnaire — Suggested Wording

### Q1 — Category
> **"What would you like to ask about?"**
- 📋 General Inquiry (academics, behavior, attendance, school matters)
- 💰 Fees & Payments

### Q2 — Which child
> **"Which child is this regarding?"**
- *(dynamically list each of the family's children, e.g. "Ahmad Raza — Class VI, Scheme 33 Campus" — reuse the existing `GET /chat/students` endpoint, which already returns name/class/section/campus/photo per child)*
- General category → final option: **"Something general — not about one specific child"**
- Financial category → final option: **"About the family account / more than one child"** (purely contextual; routing is identical either way — just helps the clerk pull up the right records)

### Q3 — Topic (pick the list matching Q1+Q2's answers)

**General, tied to a child** *(→ that child's Principal)*
- Academics / Classwork
- Behavior / Discipline
- Attendance & Leave
- Homework / Assignments
- Teacher or Classroom Concern
- Events / Activities
- Other

**General, not tied to a child** *(→ General Respondent)*
- School Timings / Calendar / Holidays
- Transport
- Admissions / Enrollment / Transfer
- Facilities (canteen, uniform, etc.)
- School Policy / Circulars
- Not sure who to ask
- Other

**Financial** *(→ finance queue)*
- Fee Voucher / Invoice Question
- Payment Not Reflecting / Receipt Issue
- Refund Request
- Discount / Concession / Scholarship
- Late Fee / Surcharge Dispute
- Fee Structure / Amount Clarification
- Other

### Final step — free text
> **"Please describe your question in your own words"** *(required, short minimum length)* — plus an optional photo/document attachment, reusing the existing chat media-upload pipeline (`ChatService.uploadMedia`).

Store these as **plain strings** (e.g. a `subtopic VARCHAR(100)` column), not hard-coded enums — same convention as `chat_messages.target_grade`/`target_section`. Easy to tweak the lists later without a migration.

---

## 3. Data Model — Prisma Schema Changes

All additive — nothing existing is dropped, altered destructively, or backfilled.

### 3.1 Enum changes
```prisma
enum StaffRole {
  SUPER_ADMIN
  CAMPUS_ADMIN
  PRINCIPAL
  FINANCE_CLERK
  RECEPTIONIST
  TEACHER
  STAFF_EDITOR
  GENERAL_RESPONDENT   // NEW
}

enum TicketCategory     { GENERAL FINANCIAL }
enum TicketStatus       { OPEN ASSIGNED CLOSED }
enum TicketSenderType   { GUARDIAN STAFF }
enum TicketEventType {
  CREATED CLAIMED TRANSFERRED FORWARDED REPLY_SUBMITTED
  REPLY_APPROVED REPLY_REJECTED CLOSED_BY_STAFF CLOSED_BY_PARENT REOPENED
}
// MessageStatus (PENDING/APPROVED/REJECTED) ALREADY EXISTS (schema.prisma:989-993) — reuse it for ticket_messages.status,
// exactly as planned: "build this on the existing approval status"
```

### 3.2 New models
```prisma
model support_tickets {
  id                    String           @id @default(uuid())
  family_id             Int
  category              TicketCategory
  subtopic              String?          @db.VarChar(100)
  student_id            Int?
  description           String
  status                TicketStatus     @default(OPEN)
  current_assignee_id   String?          // users.id — NULL while a financial ticket is unclaimed
  routed_role           StaffRole        // PRINCIPAL | FINANCE_CLERK | GENERAL_RESPONDENT (where it was originally sent)
  opened_by_guardian_id Int?
  closed_by_user_id     String?
  closed_by_guardian_id Int?
  closed_at             DateTime?
  last_message_at       DateTime         @default(now())
  last_message_snippet  String?          @db.VarChar(255)
  unread_by_staff       Int              @default(0)
  unread_by_parent      Int              @default(0)
  staff_last_read_at    DateTime?
  parent_last_read_at   DateTime?
  created_at            DateTime         @default(now())
  updated_at            DateTime         @updatedAt
  families              families         @relation(fields: [family_id], references: [id])
  students              students?        @relation(fields: [student_id], references: [cc])
  current_assignee      users?           @relation("TicketCurrentAssignee", fields: [current_assignee_id], references: [id])
  opened_by_guardian    guardians?       @relation("TicketOpenedByGuardian", fields: [opened_by_guardian_id], references: [id])
  closed_by_user        users?           @relation("TicketClosedByUser", fields: [closed_by_user_id], references: [id])
  closed_by_guardian    guardians?       @relation("TicketClosedByGuardian", fields: [closed_by_guardian_id], references: [id])
  messages              ticket_messages[]
  events                ticket_events[]

  @@index([family_id, status])
  @@index([status, routed_role])               // powers the finance shared queue
  @@index([current_assignee_id, status])       // powers "my open tickets"
  @@index([last_message_at(sort: Desc)])
}

model ticket_messages {
  id                  String            @id @default(uuid())
  ticket_id           String
  sender_type         TicketSenderType
  sender_user_id      String?
  sender_guardian_id  Int?
  message_type        ChatMessageType   // reuse existing enum (TEXT|IMAGE|VOICE|DOCUMENT)
  content             String
  media_metadata      Json?
  status              MessageStatus     @default(APPROVED)  // reuse existing enum: GUARDIAN msgs auto-APPROVED, STAFF msgs start PENDING
  is_read             Boolean           @default(false)
  reviewed_by         String?           // mirrors parent_change_requests.processed_by
  reviewed_at         DateTime?
  review_comment      String?           // mirrors parent_change_requests.comment
  created_at          DateTime          @default(now())
  ticket              support_tickets   @relation(fields: [ticket_id], references: [id], onDelete: Cascade)
  sender_user         users?            @relation("TicketMessageSenderUser", fields: [sender_user_id], references: [id])
  sender_guardian     guardians?        @relation("TicketMessageSenderGuardian", fields: [sender_guardian_id], references: [id])
  reviewer            users?            @relation("TicketMessageReviewer", fields: [reviewed_by], references: [id])

  @@index([ticket_id, created_at(sort: Desc)])
  @@index([status, sender_type])    // powers the Super Admin "pending approvals" queue
}

model ticket_events {  // append-only audit log: claims/transfers/forwards/approvals/closures
  id                Int             @id @default(autoincrement())
  ticket_id         String
  event_type        TicketEventType
  actor_user_id     String?
  actor_guardian_id Int?
  from_user_id      String?
  to_user_id        String?
  note              String?
  created_at        DateTime        @default(now())
  ticket            support_tickets @relation(fields: [ticket_id], references: [id], onDelete: Cascade)
  actor_user        users?          @relation("TicketEventActorUser", fields: [actor_user_id], references: [id])
  actor_guardian    guardians?      @relation("TicketEventActorGuardian", fields: [actor_guardian_id], references: [id])
  from_user         users?          @relation("TicketEventFromUser", fields: [from_user_id], references: [id])
  to_user           users?          @relation("TicketEventToUser", fields: [to_user_id], references: [id])

  @@index([ticket_id, created_at])
}
```
A proper append-only event timeline (vs. a couple of nullable FK columns like `postdated_cheques.received_by`/`cashed_by`) because a ticket can change hands more than once.

### 3.3 Back-relations needed on existing models
- `users`: add the `GENERAL_RESPONDENT` enum value, plus ~7 back-relation array fields (`TicketCurrentAssignee`, `TicketClosedByUser`, `TicketMessageSenderUser`, `TicketMessageReviewer`, `TicketEventActorUser`, `TicketEventFromUser`, `TicketEventToUser`) — same idiom as the existing `postdated_cheques_cashed users[] @relation("ChequeCashedBy")`.
- `families`: add `support_tickets support_tickets[]`
- `guardians`: add 4 back-relation arrays (opened/closed tickets, sent messages, close-events)
- `students`: add `support_tickets support_tickets[]`

### 3.4 What happens to `chat_conversations`/`chat_messages`
**Leave them alone — parallel build, then cut over the UI, don't evolve in place:**
- Migration only ADDs — zero `DROP`/`ALTER ... DROP COLUMN` on chat tables.
- Announcements keep using `chat_messages`/`chat_conversations` exactly as today (sentinel conversation `00000000-0000-0000-0000-000000000000`, `publishAnnouncement`/`handleSendAnnouncement`, the announcement-merge logic in `getChatHistory`) — completely untouched.
- The 1:1-thread code paths (`getAdminInbox`, `getOrCreateConversation`, non-announcement `createMessage`, `markAsRead`, `enterChat`/`leaveChat`/`sendMessage` socket handlers, `/chat/inbox`/`/chat/history/*`/`/chat/messages*` REST endpoints) simply stop being what the UI routes to. Leave the dormant code as a rollback path initially; remove in a follow-up cleanup PR after a burn-in period.
- **No backfill** of old conversations into tickets — the shapes don't line up (old threads carry no category/status/assignee semantics to convert from). Old rows just become read-only history.

### 3.5 Migration sequencing caveat
Generate via `npx prisma migrate dev --name add_support_tickets` and review the diff. Postgres requires `ALTER TYPE ... ADD VALUE` to commit outside the same transaction as dependent table creation on some versions — if Prisma complains, split into two migrations: `..._add_general_respondent_role` (enum value only) committed first, then `..._add_support_tickets` (new enums + tables).

---

## 4. Routing & Assignment Engine

New helper file: `src/common/support-ticket-routing.ts` (sibling to the existing `src/common/class-band-ids.ts`) — pure, unit-testable functions, no DB coupling.

```ts
// Principal lookup — campus-wide principals (empty allowed_class_ids) win over class-band matches
export function principalLookupWhere(campusId: number, classId: number) {
  return {
    role: 'PRINCIPAL' as const,
    is_active: true,
    OR: [
      { campus_id: campusId, allowed_class_ids: { equals: [] } },
      { campus_id: campusId, allowed_class_ids: { has: classId } },
    ],
  };
}
// then: candidates.sort((a, b) => a.allowed_class_ids.length - b.allowed_class_ids.length)[0]
// — makes "campus-wide wins" deterministic and is a safety net if the roster ever overlaps in the future
```

- **General Respondent lookup**: `prisma.users.findFirst({ where: { role: 'GENERAL_RESPONDENT', is_active: true }, orderBy: { created_at: 'asc' } })`
- **Claim** (race-safe, see §1.3): `support_tickets.updateMany({ where: { id, category: 'FINANCIAL', status: 'OPEN', current_assignee_id: null }, data: { current_assignee_id: clerkId, status: 'ASSIGNED' } })` — `count === 0` ⇒ already claimed by someone else (`ConflictException`)
- **Transfer**: identical atomic-update pattern, keyed on `current_assignee_id = <current holder's id>` instead of `null`
- **Sole-responder enforcement on reply**: `if (ticket.category === 'FINANCIAL' && ticket.current_assignee_id !== actor.id) throw new ForbiddenException(...)`. Visibility (the `GET` queue) stays open to all 3 clerks via `WHERE routed_role = 'FINANCE_CLERK' AND status IN ('OPEN','ASSIGNED')`; only *posting* is gated.
- **Closed-ticket visibility helper**:
```ts
const RESPONDER_ROLES: StaffRole[] = ['PRINCIPAL', 'FINANCE_CLERK', 'GENERAL_RESPONDENT'];
export function closedTicketVisibilityWhere(staff: { role: StaffRole }) {
  if (staff.role === 'SUPER_ADMIN' || staff.role === 'CAMPUS_ADMIN') return { status: 'CLOSED' as const };
  if (RESPONDER_ROLES.includes(staff.role)) return { status: 'CLOSED' as const, /* see §8.1 — key on closed_by_role vs routed_role */ };
  return { status: 'CLOSED' as const, id: '__none__' }; // no access
}
```

### Seeding the new role
Add to `ROSTER` in `scripts/seed-staff-roster.ts` (after the `CAMPUS_ADMIN` entry, ~line 38):
```ts
{ username: 'general.respondent', full_name: 'General Query Desk', role: 'GENERAL_RESPONDENT', campus_id: null },
```
**Compile-time gotcha**: `scripts/seed-permissions.ts` types its mapping as `Record<StaffRole, string[]>` (line 86) — adding `GENERAL_RESPONDENT` to `StaffRole` means **the project will not compile** until that map gets a `GENERAL_RESPONDENT: [...]` entry too (see §8.2 for what permissions to grant).

---

## 5. Approval Workflow

Mirror `src/modules/parent-change-requests/parent-change-requests.service.ts::processRequest` (lines 72-100) closely — it already has exactly the right shape: assert `status === 'PENDING'`, then inside a `$transaction`, update `{status, comment, processed_by, processed_at}` and apply the side effect *only if approved*.

```ts
// Posting a staff reply — ALWAYS starts PENDING, no side effects fire yet
const message = await tx.ticket_messages.create({
  data: { ticket_id, sender_type: 'STAFF', sender_user_id: staff.id, message_type, content,
          media_metadata, status: 'PENDING' },
});
await tx.ticket_events.create({ data: { ticket_id, event_type: 'REPLY_SUBMITTED', actor_user_id: staff.id } });
// Deliberately do NOT touch last_message_at / unread_by_parent / broadcast to the parent's room here —
// that has to wait for approval (divergence from today's ChatService.createMessage, which updates unconditionally)
```

```ts
async reviewReply(messageId: string, dto: { status: 'APPROVED'|'REJECTED'; comment?: string }, superAdmin: IJwtStaffPayload) {
  const message = await this.prisma.ticket_messages.findUniqueOrThrow({ where: { id: messageId }, include: { ticket: true } });
  if (message.status !== 'PENDING') throw new BadRequestException('Reply has already been reviewed');
  return this.prisma.$transaction(async (tx) => {
    const updated = await tx.ticket_messages.update({
      where: { id: messageId },
      data: { status: dto.status, review_comment: dto.comment, reviewed_by: superAdmin.sub, reviewed_at: new Date() },
    });
    if (dto.status === 'APPROVED') {
      await tx.support_tickets.update({ where: { id: message.ticket_id }, data: {
        last_message_at: new Date(),
        last_message_snippet: updated.message_type === 'TEXT' ? updated.content.slice(0, 50) : `[${updated.message_type}]`,
        unread_by_parent: { increment: 1 },
      }});
      // → broadcastReplyApproved: emit to family_app_{familyId} (delivers to parent) + staff_inbox_{responderId}
      // → FcmService.sendToFamily(...) push notification
    } else {
      // → broadcastReplyRejected: emit ONLY to staff_inbox_{responderId}, carrying review_comment so they can revise
    }
    await tx.ticket_events.create({ data: { ticket_id: message.ticket_id, actor_user_id: superAdmin.sub,
      event_type: dto.status === 'APPROVED' ? 'REPLY_APPROVED' : 'REPLY_REJECTED' } });
    return updated;
  });
}
```

**Endpoints**:
- `GET /support-tickets/approvals/pending` — `JwtStaffGuard` + inline `role === 'SUPER_ADMIN'` check (no generic `@Roles()` guard exists in this codebase — RBAC here is permission-key/CASL-based via `PoliciesGuard`, so use a small inline check the same way `parent_change_requests` trusts its guard layer). Query: `ticket_messages.findMany({ where: { status: 'PENDING', sender_type: 'STAFF' }, orderBy: { created_at: 'asc' }, include: {...} })` — FIFO for fairness.
- `PATCH /support-tickets/messages/:messageId/review` — body `{ status, comment? }`

---

## 6. Backend Module Structure

New module `src/modules/support-tickets/` (sibling to `chat/` and `parent-change-requests/`):
```
support-tickets/
  support-tickets.module.ts
  support-tickets.controller.ts
  support-tickets.service.ts
  dto/{create-ticket, create-ticket-message, review-ticket-message, transfer-ticket, close-ticket}.dto.ts
  support-tickets.{controller,service}.spec.ts
```
- **Imports**: `[PrismaModule, StorageModule, AuthModule, FcmModule, ChatModule]` — the last specifically to **reuse `ChatService.uploadMedia()`/`getMediaFile()`** (don't duplicate the S3-key-by-mimetype logic at `chat.service.ts:197-219`) and to extend `ChatGateway` rather than fork it.
- Register in `app.module.ts` directly after `ChatModule` (~line 72).

### Endpoints (parent-facing, `JwtParentGuard`)
`GET /mine` · `GET /origination-options` · `POST /` · `GET /:id` · `POST /:id/messages` · `POST /:id/close` · `POST /mark-read`

### Endpoints (staff-facing, `JwtStaffGuard`)
`GET /my-queue` · `GET /finance-queue` · `GET /closed` · `GET /:id` · `POST /:id/claim` · `POST /:id/transfer` · `POST /:id/messages` · `POST /:id/close` · `GET /approvals/pending` · `PATCH /messages/:messageId/review` · `POST /media` (delegates to injected `ChatService`)

### Extending `ChatGateway` — extend in place, don't fork it
NestJS gateways can't cleanly share a `Server` instance, and `ChatGateway.afterInit`'s JWT auth middleware (lines 52-83) plus `handleConnection`'s room bootstrap (lines 85-134) is exactly the connection plumbing tickets need too. Add to the existing `STAFF` branch of `handleConnection`:
```ts
if (payload.userType === 'STAFF') {
  client.join('admin_inbox');
  client.join(`staff_inbox_${payload.sub}`);
  if (payload.role === 'FINANCE_CLERK')      client.join('finance_queue');
  if (payload.role === 'SUPER_ADMIN')        client.join('super_admin_approvals');
  if (payload.role === 'GENERAL_RESPONDENT') client.join('general_respondent_inbox');
}
```
New broadcast methods (parallel to `broadcastNewMessage` at line 242): `broadcastTicketCreated`, `broadcastTicketClaimed`, `broadcastTicketTransferred`, `broadcastReplyPendingApproval`, `broadcastReplyReviewed`, `broadcastTicketClosed`. New `@SubscribeMessage` handlers: `enterTicket`/`leaveTicket` (presence rooms `ticket_{id}`), `sendTicketMessage`. Group all of this under a clearly-commented `// ─── Support Tickets ──` section.

---

## 7. Frontend Integration

### 7.1 Flutter (parent-facing)
Confirmed: the webapp only supports staff login (`authService.loginStaff` → `/v1/auth/staff/login`) — so the MCQ questionnaire is **Flutter-only**.

New sibling feature `lib/features/support_tickets/{data,domain,presentation}` — mirror the exact layout of `features/chat/` (Clean Architecture, BLoC):
- **domain/entities**: `support_ticket.dart`, `ticket_message.dart` *(name its review-status field e.g. `TicketMessageReviewStatus` — `chat_message.dart` already defines a client-side `MessageStatus{queued,sending,sent,error}` enum; avoid colliding with it)*, `origination_options.dart`
- **domain/repositories**: `support_ticket_repository.dart`, mirroring `chat_repository.dart`'s shape
- **data**: `*_dto.dart` + `support_ticket_repository_impl.dart`
- **presentation/bloc**: `ticket_origination_bloc` (drives the MCQ wizard — short-lived, separate from the thread bloc), `support_ticket_list_bloc` (parameterized by a `TicketListScope` enum so it serves parent "My Tickets" AND staff "My Queue"/"Finance Queue"/"Closed"), `ticket_thread_bloc`
- **presentation/pages**: `ticket_origination_page` (stepper/wizard), `ticket_list_page`, `ticket_thread_page` — reuse `chat_bubble.dart`/`message_input.dart`/`swipe_to_reply.dart`/`full_screen_image_viewer.dart` from `features/chat/presentation/widgets/` directly (generic message-rendering, no chat-specific coupling)
- **presentation/widgets**: `mcq_question_card`, `ticket_status_badge`, `reply_review_status_chip`, `claim_transfer_sheet`

`POST /support-tickets` body: `{ category, studentId?, subtopic?, description }` — **routing happens entirely server-side**; the client never selects or sends a target staff member (security + centralized testability). Reuse `GET /chat/students` for Q2's child list (already returns name/class/section/campus/photo per child).

Edge cases to handle in the wizard: a single-child family should skip Q2 (or auto-select); a family with zero active students should only see the "general, no child" path.

### 7.2 Webapp (staff-facing)
New `src/features/support-tickets/components/` (kebab-case, matching `families`/`admissions` siblings):
- `TicketQueueList.tsx` — replaces `ChatInbox`'s role; reuse its search-filter (`useState`+`useMemo`) and card-list idiom; tabbed by scope ("My Queue" / "Finance Queue" / "Closed")
- `TicketThread.tsx` — replaces `ChatWindow`'s role, plus: ticket-header bar (category/subtopic/student/status/assignee), per-message review-status badges, role-gated action buttons (Claim/Transfer/Forward/Close)
- `ClaimTransferModal.tsx`
- `SuperAdminApprovalQueue.tsx` (rendered only when `role === 'SUPER_ADMIN'`)

New `src/store/slices/supportTicketsSlice.ts` — a deliberate departure from the chat page's local `useState`, instead following the prevailing `studentsSlice.ts` Redux pattern (`createSlice` + `createAsyncThunk`), justified because ticket state must be shared live across the queue list, thread view, and notification badges. New route(s) under `app/(dashboard)/support-tickets/`.

---

## 8. Open Decisions to Confirm Before Writing Code

Small choices now; expensive schema rework later if guessed wrong:

### 8.1 Peer-visibility grouping key (§1.7)
Group closed-ticket peer-visibility by `routed_role` (where it was *originally* sent) or by the role of whoever was holding it *when it closed*? **Recommendation: closing-time holder** — add a denormalized `closed_by_role: StaffRole?` column populated at close time, and key `closedTicketVisibilityWhere` on that. This is the version of "same level" that means something once a ticket has been forwarded across role lines.

### 8.2 `GENERAL_RESPONDENT` permissions
What should this account be able to do elsewhere in the app? Likely very little — its job is reading and forwarding, not acting on student/financial records. Best guess: `[]` or just `['students.directory.view']`. Needs to be decided so `seed-permissions.ts`'s `roleMappings` map can be completed (required for the project to compile — see §4).

### 8.3 Forward/transfer symmetry
Should a ticket forwarded by the General Respondent to, say, a Principal be transferable onward only to *another Principal* (peer-only — the suggested default, keeps rules simple/symmetric), or should the receiving party retain "send to anyone" power too?

### 8.4 Identity behind the new account
A single shared login (e.g. `general.respondent`) — staffed by one dedicated person, or rotated among existing staff? Doesn't change the build, but affects how whoever uses it gets briefed.

---

## 9. Build Order & Verification

1. **Schema + migration** — enum value, new enums, three tables, back-relations; seed `general.respondent` into `seed-staff-roster.ts` + its permission mapping into `seed-permissions.ts`.
2. **Routing engine** (testable without UI) — unit-test the principal lookup against real roster shapes (campus-wide vs. class-band) and concurrent-claim behavior (two simultaneous claims on one ticket → exactly one wins).
3. **Messaging + approval service** — with explicit tests proving a PENDING/REJECTED staff message is invisible through *every* read path: thread fetch, unread counters, snippets, socket broadcasts, push notifications. Easiest place to accidentally leak a not-yet-approved message.
4. **Gateway + controller wiring.**
5. **Staff-side UI first** (webapp) — the approval loop can't be exercised end-to-end without a staff reply UI and a Super Admin approval UI; building parent-side first leaves the core new mechanic untestable.
6. **Parent-side UI** (Flutter) — the MCQ wizard; budget extra time for conditional Q3 branching and the edge cases noted in §7.1.
7. **End-to-end pass** through concrete scenarios: general+child routing · general+no-child + forward · financial claim/transfer/exclusivity · approval leak-proofing in both directions · hierarchical closed-ticket visibility · concurrent-claim race.

**To verify once built**: log in as a parent (Flutter) and as each affected role — Super Admin (`muhammad.hussain.mirza`), a Principal (`hira.khadim`), a Finance Clerk (`fozia.hussain`), and the new General Respondent — and walk one ticket of each category through its full lifecycle: open → route → claim/assign → reply → approve/reject → close → confirm hierarchical visibility, across both the webapp and the Flutter app.

---

## Critical Files Referenced
- `tafs-backend/prisma/schema.prisma` — lines 572-596 (`users`), 672-710 (`chat_conversations`/`chat_messages`), 946-993 (enums)
- `tafs-backend/src/modules/parent-change-requests/parent-change-requests.service.ts` — approval-workflow template (`processRequest`, lines 72-100)
- `tafs-backend/src/modules/chat/chat.service.ts` — `createMessage` (308-361), `getOrCreateConversation` (245-257), `uploadMedia` (197-219)
- `tafs-backend/src/modules/chat/chat.gateway.ts` — `handleConnection` (85-134), `broadcastNewMessage` (242-270)
- `tafs-backend/src/common/class-band-ids.ts` — model for the new routing helper
- `tafs-backend/scripts/seed-staff-roster.ts` — roster to extend (lines 30-89)
- `tafs-backend/scripts/seed-permissions.ts` — `roleMappings` (line 86) that must gain a `GENERAL_RESPONDENT` entry
