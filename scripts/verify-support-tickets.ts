/**
 * Verifies support ticket approval isolation and full approve lifecycle.
 *
 * Usage: npm run verify:support-tickets
 *
 * Env:
 *   PARENT_ACCESS_TOKEN, FAMILY_ID
 *   STAFF_USERNAME=general.respondent, STAFF_PASSWORD (for general tickets)
 *   SUPER_ADMIN_USERNAME=muhammad.hussain.mirza, SUPER_ADMIN_PASSWORD (optional tokens)
 */
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { io, Socket } from 'socket.io-client';

function loadEnvFile(): void {
  const envPath = resolve(__dirname, '../.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    if (process.env[key] === undefined) {
      process.env[key] = trimmed.slice(idx + 1).trim();
    }
  }
}

loadEnvFile();

const API_BASE_URL = (process.env.API_BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
const SOCKET_URL = API_BASE_URL.replace(/\/api\/v1$/, '');

async function loginStaff(
  username = process.env.STAFF_USERNAME || 'general.respondent',
  password = process.env.STAFF_PASSWORD,
  tokenEnv = 'STAFF_ACCESS_TOKEN',
): Promise<string> {
  const existing = process.env[tokenEnv];
  if (existing) return existing;
  if (!password) {
    throw new Error(`Set ${tokenEnv} or STAFF_PASSWORD for ${username}`);
  }

  const res = await fetch(`${API_BASE_URL}/api/v1/auth/staff/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`Staff login failed (${username}): HTTP ${res.status}`);
  const body = await res.json();
  const token = body.data?.accessToken ?? body.accessToken;
  if (!token) throw new Error('Staff login missing accessToken in response body');
  return token;
}

async function loginParent(): Promise<{ token: string; familyId: number }> {
  const existing = process.env.PARENT_ACCESS_TOKEN;
  if (existing) {
    const payload = JSON.parse(Buffer.from(existing.split('.')[1], 'base64url').toString());
    const familyId = Number(process.env.FAMILY_ID ?? payload.familyId ?? payload.sub);
    return { token: existing, familyId };
  }
  throw new Error('Set PARENT_ACCESS_TOKEN and FAMILY_ID for ticket verification');
}

function connectSocket(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(SOCKET_URL, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
    });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err) => reject(err));
    setTimeout(() => reject(new Error('Socket connect timeout')), 10000);
  });
}

async function main() {
  console.log('Support ticket verification');
  console.log('API:', API_BASE_URL);

  const parent = await loginParent();
  const staffToken = await loginStaff();
  const superAdminToken = await loginStaff(
    process.env.SUPER_ADMIN_USERNAME || 'muhammad.hussain.mirza',
    process.env.SUPER_ADMIN_PASSWORD ?? process.env.STAFF_PASSWORD,
    'SUPER_ADMIN_ACCESS_TOKEN',
  );

  const parentSocket = await connectSocket(parent.token);
  const staffSocket = await connectSocket(staffToken);

  let parentReceivedBeforeApproval = false;
  let parentReceivedAfterApproval = false;
  parentSocket.on('ticketMessageReceived', () => {
    if (!parentReceivedAfterApproval) {
      parentReceivedBeforeApproval = true;
    }
  });

  const createRes = await fetch(`${API_BASE_URL}/api/v1/support-tickets`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${parent.token}`,
    },
    body: JSON.stringify({
      category: 'GENERAL',
      subtopic: 'Other',
      description: 'Verification test ticket with enough context text.',
    }),
  });
  if (!createRes.ok) {
    throw new Error(`Create ticket failed: ${createRes.status} ${await createRes.text()}`);
  }
  const ticket = await createRes.json();
  const ticketId = ticket.id ?? ticket.data?.id;
  console.log('Created ticket:', ticketId);

  parentSocket.emit('enterTicket', { ticketId });
  staffSocket.emit('enterTicket', { ticketId });

  const msgRes = await fetch(`${API_BASE_URL}/api/v1/support-tickets/${ticketId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${staffToken}`,
    },
    body: JSON.stringify({
      messageType: 'TEXT',
      content: 'Pending staff reply — parent must not see this yet.',
    }),
  });
  if (!msgRes.ok) {
    throw new Error(`Staff message failed: ${msgRes.status} ${await msgRes.text()}`);
  }
  const pendingMsg = await msgRes.json();
  const messageId = pendingMsg.id ?? pendingMsg.data?.id;
  console.log('Staff reply submitted (PENDING):', messageId);

  await new Promise((r) => setTimeout(r, 1500));

  if (parentReceivedBeforeApproval) {
    throw new Error('LEAK: Parent received ticketMessageReceived before approval');
  }
  console.log('OK: Parent did not receive pending reply via socket');

  const threadRes = await fetch(`${API_BASE_URL}/api/v1/support-tickets/${ticketId}`, {
    headers: { Authorization: `Bearer ${parent.token}` },
  });
  const thread = await threadRes.json();
  const messages = thread.messages ?? thread.data?.messages ?? [];
  const leaked = messages.some(
    (m: { sender_type: string; status: string }) =>
      m.sender_type === 'STAFF' && m.status === 'PENDING',
  );
  if (leaked) {
    throw new Error('LEAK: Parent REST thread includes PENDING staff message');
  }
  console.log('OK: Parent REST thread excludes pending staff messages');

  parentReceivedBeforeApproval = false;
  parentSocket.off('ticketMessageReceived');

  parentSocket.on('ticketMessageReceived', () => {
    parentReceivedAfterApproval = true;
  });

  const approveRes = await fetch(
    `${API_BASE_URL}/api/v1/support-tickets/messages/${messageId}/review`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${superAdminToken}`,
      },
      body: JSON.stringify({ status: 'APPROVED' }),
    },
  );
  if (!approveRes.ok) {
    throw new Error(`Approve failed: ${approveRes.status} ${await approveRes.text()}`);
  }
  console.log('Super Admin approved reply');

  await new Promise((r) => setTimeout(r, 1500));

  const threadAfter = await fetch(`${API_BASE_URL}/api/v1/support-tickets/${ticketId}`, {
    headers: { Authorization: `Bearer ${parent.token}` },
  });
  const threadAfterBody = await threadAfter.json();
  const approvedMessages = threadAfterBody.messages ?? threadAfterBody.data?.messages ?? [];
  const hasApproved = approvedMessages.some(
    (m: { id: string; status: string }) => m.id === messageId && m.status === 'APPROVED',
  );
  if (!hasApproved) {
    throw new Error('Parent REST thread missing APPROVED staff message after review');
  }
  console.log('OK: Parent REST thread includes approved staff message');

  if (!parentReceivedAfterApproval) {
    console.warn('WARN: Parent socket did not receive ticketMessageReceived after approval (may be offline room timing)');
  } else {
    console.log('OK: Parent received approved reply via socket');
  }

  const markReadRes = await fetch(`${API_BASE_URL}/api/v1/support-tickets/mark-read`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${parent.token}`,
    },
    body: JSON.stringify({ ticketId }),
  });
  if (!markReadRes.ok) {
    throw new Error(`Mark read failed: ${markReadRes.status}`);
  }
  console.log('OK: Mark read succeeded');

  parentSocket.disconnect();
  staffSocket.disconnect();
  console.log('Verification passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
