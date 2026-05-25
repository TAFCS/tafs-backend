# Chat Hub & Parent App: Socket Idle Investigation

**Date:** May 25, 2026  
**Symptom:** After the parent phone app is idle or backgrounded, Chat Hub (web) still works but the phone stops sending/receiving live messages—the socket appears dead.  
**Repos:** `tafs-flutter` (parent app), `tafs-backend` (Socket.IO gateway), `tafs-webapp` (staff Chat Hub)

---

## Executive summary

This is **not** a Chat Hub web bug. Staff use a separate, well-defended socket ([`SocketContext.tsx`](../../tafs-webapp/src/context/SocketContext.tsx)). The parent phone keeps one Socket.IO connection in [`ChatRepositoryImpl`](../tafs_flutter/lib/features/chat/data/repositories/chat_repository_impl.dart). After background/idle:

1. The **server** drops silent clients (no pong within 60s)—expected.
2. The **Flutter app** often fails to establish a **fresh** connection on return (zombie `connected` flag, weak resume logic).
3. The **chat BLoC** can **block sends** when the socket flag is false, leaving messages stuck in the local outbox.
4. A **failed JWT refresh** can set `reconnectionAttempts` to `0` and permanently stop auto-reconnect.

Ashhal’s backend push **`900756a`** (May 25, 2026) adds FCM, Redis, admin REST fallback, and gateway polish—it **does not** fix the phone idle reconnect path. Flutter follow-up **`08c8151`** only adds disconnect logging and enables resume on web.

**Fix priority:** Flutter client (Phases 1–4 below). Optional backend observability only.

---

## How the system is supposed to work

```
Staff (Chat Hub web)  ──socket──►  NestJS ChatGateway  ◄──socket──  Parent (Flutter app)
                                        │
                                        ├── family_app_{familyId}  (all parent devices)
                                        ├── family_chat_{familyId} (chat screen open / FCM suppress)
                                        └── admin_inbox              (staff inbox)
```

| Path | Transport | Used when |
|------|-----------|-----------|
| Staff → family | Socket `sendMessage` → `receiveMessage` on `family_app_*` | Chat Hub live |
| Family → staff | Socket `sendMessage` → `receiveMessage` on `admin_inbox` | Phone live |
| Family → staff fallback | `POST /chat/messages` (parent REST) | Phone `sendMessage()` / outbox flush |
| Staff → family fallback | `POST /chat/messages/admin` | Web socket down (**added in 900756a**) |
| Staff → family push | FCM when parent **not** in `family_chat_*` | Socket dead or chat closed |

- **JWT** is verified only at **handshake** ([`chat.gateway.ts`](../../tafs-backend/src/modules/chat/chat.gateway.ts) middleware).
- Parent access token TTL: **1 hour** (`ACCESS_TOKEN_TTL = '1h'` in backend auth service).
- Server pings: **every 25s**, disconnect if no pong within **60s**.

---

## Re-investigation after push `900756a`

### Backend (`900756a`) — 5 files

| File | Change | Fixes phone idle? |
|------|--------|-------------------|
| `redis-io.adapter.ts` | Redis reconnect, logging, in-memory fallback | No (multi-instance only) |
| `fcm.service.ts` | Purge invalid FCM tokens | Partial (push only) |
| `chat.controller.ts` | `POST /chat/messages/admin` | No (staff only) |
| `chat.gateway.ts` | `isParentInChatRoom`, admin viewing maps, `senderName` | No (ping unchanged) |
| `chat.service.ts` | Store `sender_name` | No |

### Flutter (`08c8151`) — 1 file

- Log disconnect `reason`; do not manually `connect()` on disconnect.
- Resume handler runs on web too.
- **Still:** on resume, if `connected == true` → only `drainOutbox()`, no force reconnect.

### Web (`eb7e2aa`)

- Chat Hub: refs for `selectedFamilyId`, `enterChat`/`leaveChat`, reconnect sync.
- Helps **staff**; does not change parent phone lifecycle.

---

## Timeline: what happens when the phone is backgrounded

| Time | Server | Flutter client | User-visible |
|------|--------|----------------|--------------|
| T+0 | Connected | Socket in `family_app_*` | Chat works |
| Background | — | OS may suspend isolate / stop pings | — |
| ~1–2 min | No pong → disconnect | `onDisconnect` may fire while suspended | — |
| Reconnect in background | May handshake or fail (JWT, no network) | Auto-reconnect may stall | — |
| User opens app | Old session gone or half-open | `AppLifecycleState.resumed` | — |
| **Bug path A** | — | `connected == false` → `connect()` | May recover |
| **Bug path B** | — | `connected == true` (zombie) → **only** `drainOutbox()` | No live messages; sends hang |
| **Bug path C** | — | `reconnectionAttempts == 0` | Nothing reconnects; sends queued forever |

---

## Root causes (evidence-backed)

### P0 — Zombie `connected` flag

```dart
// chat_repository_impl.dart
bool get isConnected => _socket != null && _socket!.connected;
```

After background, TCP can be dead while the client library still reports `connected == true`.

**Resume handler (insufficient):**

```dart
void didChangeAppLifecycleState(AppLifecycleState state) {
  if (state == AppLifecycleState.resumed) {
    if (_socket != null && !_socket!.connected) {
      _socket!.connect();
    } else if (isConnected) {
      unawaited(drainOutbox());  // no force reconnect
    }
  }
}
```

**`connect()` early-return** when socket exists and appears connected—cached token is updated but connection is not recycled.

**Impact:** No inbound `receiveMessage`; outbound may wait **15s** on socket ack then REST (if send path runs).

---

### P0 — BLoC blocks send when socket flag is false

```dart
// chat_bloc.dart line ~307
await repository.enqueueOutbox(outboxEntry);
if (!repository.isConnected) return;  // never calls sendMessage()
```

`repository.sendMessage()` already falls back to `POST /chat/messages`, but it is never invoked when `isConnected` is false.

Outbox flush runs on `onConnect`, `ChatReconnected`, or `resumed` **only when** `isConnected`—a catch-22 if reconnect is broken.

---

### P0 — Failed JWT refresh bricks auto-reconnect

On `connect_error` with `token_expired`:

1. Sets `reconnectionAttempts = 0`.
2. Refreshes via standalone `Dio()` (not `TokenInterceptor`).
3. On **success:** restores `99999` and `connect()`.
4. On **catch** (network error): only logs—**does not restore** `reconnectionAttempts`.

After **~1 hour** idle, expired JWT on reconnect triggers this path frequently.

`onSessionExpired` is exposed but **nothing subscribes** in the app.

---

### P1 — HTTP token refresh does not heal the socket

[`TokenInterceptor`](../tafs_flutter/lib/core/network/token_interceptor.dart) updates secure storage on 401; it never updates socket `auth` or forces reconnect.

Other screens can work while chat stays on a dead or zombie socket.

---

### P1 — Misleading UI

[`chat_page.dart`](../tafs_flutter/lib/features/chat/presentation/pages/chat_page.dart) shows hardcoded green **ONLINE**—not tied to `isConnected`, reconnecting, or outbox errors.

---

### P2 — Other notes

- `tokenExpired` socket listener in Flutter—backend **does not emit** this event.
- `enterChat` / `leaveChat` affect `family_chat_*` (FCM suppression), not `family_app_*` delivery.
- FCM can deliver staff messages when socket is dead **if** server does not think parent is still in `family_chat_*` and tokens are valid (900756a helps purge stale tokens).
- Double `ChatStarted`: app launch + `AuthAuthenticated` in [`auth_gate.dart`](../tafs_flutter/lib/features/auth/presentation/auth_gate.dart).

---

## What can be fixed

### Phase 1 — Connection health (Flutter, highest impact)

**File:** `lib/features/chat/data/repositories/chat_repository_impl.dart`

1. Add `ensureSocketHealthy({bool forceReconnect = false})`:
   - Load latest token from `AuthLocalDataSource`.
   - Always restore `reconnectionAttempts` to a large value / unlimited (match web `Infinity`).
   - On `resumed`: **`disconnect()` then `connect()`** to clear zombies.
   - If `_socket == null`, call `connect()`.

2. In `connect_error` **`catch` / `finally`**: always restore `reconnectionAttempts` even when refresh fails (retry later; do not brick).

3. On `onConnect`: keep `drainOutbox()` + FCM register; re-emit `enterChat` when user is on chat tab (coordinate with bloc `isUserInChat`).

**Optional on `paused`:** do nothing (let server timeout) or proactive `disconnect()` to avoid zombie—team preference.

---

### Phase 2 — Send path always delivers (Flutter)

**File:** `lib/features/chat/presentation/bloc/chat_bloc.dart`

- **Remove** `if (!repository.isConnected) return;` after enqueue.
- Always call `repository.sendMessage()` (socket → REST fallback already in repository).
- Optionally show `sending` instead of `queued` when REST will run.

---

### Phase 3 — Token sync + session expiry (Flutter)

| File | Change |
|------|--------|
| `token_interceptor.dart` | After successful parent refresh, invoke callback |
| `injection_container.dart` | Wire callback → `chatRepository.ensureSocketHealthy(forceReconnect: true)` |
| `auth_gate.dart` or `chat_bloc.dart` | Subscribe `onSessionExpired` → `ChatStopped()` + logout |

---

### Phase 4 — Truthful connection UI (Flutter)

**Files:** `chat_repository.dart`, `chat_repository_impl.dart`, `chat_page.dart`

- Expose `Stream<SocketConnectionState>` (`disconnected` | `connecting` | `connected`).
- Replace static **ONLINE** with Connected / Reconnecting / Offline.

---

### Phase 5 — Optional backend (observability)

**File:** `tafs-backend/src/modules/chat/chat.gateway.ts`

- `@SubscribeMessage('ping')` with ack; client uses on resume (3s timeout → force reconnect).
- Log disconnect with `userType`, `familyId`, reason.

Not required for the core phone idle fix.

---

## Files to change (checklist)

| Priority | Repo | File |
|----------|------|------|
| P0 | Flutter | `lib/features/chat/data/repositories/chat_repository_impl.dart` |
| P0 | Flutter | `lib/features/chat/presentation/bloc/chat_bloc.dart` |
| P1 | Flutter | `lib/core/network/token_interceptor.dart` |
| P1 | Flutter | `lib/injection_container.dart` |
| P1 | Flutter | `lib/features/auth/presentation/auth_gate.dart` |
| P2 | Flutter | `lib/features/chat/presentation/pages/chat_page.dart` |
| P2 | Flutter | `lib/features/chat/domain/repositories/chat_repository.dart` |
| P3 | Backend | `src/modules/chat/chat.gateway.ts` (optional) |

**No Chat Hub web changes required** for the parent phone idle bug.

---

## Manual test plan

1. **Background 2 min** — Open chat, background app 2+ min, return; staff sends from Hub → message appears without manual refresh.
2. **Background 5 min** — Parent replies → staff sees in Hub within ~15s max.
3. **Airplane mode 30s** — Toggle in chat; restore network → recovery + outbox drain.
4. **Idle 65+ min** — Token expired; send message → refresh + deliver or clean logout.
5. **Failed refresh** — Simulate failed `/auth/parent/refresh` → reconnect must still retry (not brick).
6. **Queued UI** — Message must not stay `queued` forever; error/retry when appropriate.

---

## Reference: web client pattern to mirror

[`tafs-webapp/src/context/SocketContext.tsx`](../../tafs-webapp/src/context/SocketContext.tsx):

- `reconnectionAttempts: Infinity`
- On `token_expired`: pause reconnect, refresh, restore `Infinity`, `connect()`
- Does not manually `connect()` on every `disconnect` (avoids loops)

Flutter should match **unlimited reconnect** and **never leave `reconnectionAttempts` at 0** after transient refresh failure, plus **force reconnect on mobile resume** (web tabs often get a fresh stack on focus).

---

## One-paragraph answer

The socket “dies” because the server correctly closes idle connections when the phone stops answering pings in the background, while the Flutter app does not reliably open a new connection when the user returns: it trusts a stale `connected` flag, can permanently disable auto-reconnect after a failed token refresh, and the chat BLoC refuses to send over REST when the socket flag is false. Staff Chat Hub keeps working on a healthier web socket. Fix by forcing a clean reconnect on resume, never bricking reconnect after refresh errors, always allowing REST send, and syncing tokens into socket auth after HTTP refresh.
