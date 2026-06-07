/**
 * Verifies bidirectional chat socket delivery (parent ↔ staff) against a running backend.
 *
 * Usage:
 *   npm run verify:chat-socket
 *
 * Env (tokens — preferred):
 *   PARENT_ACCESS_TOKEN, STAFF_ACCESS_TOKEN, FAMILY_ID
 *
 * Env (login fallback):
 *   API_BASE_URL=http://localhost:8080
 *   PARENT_USERNAME, PARENT_PASSWORD
 *   STAFF_USERNAME, STAFF_PASSWORD
 *   FAMILY_ID (optional; derived from parent JWT when omitted)
 *
 * Env (signed test tokens — uses JWT_SECRET from .env when no credentials are set):
 *   JWT_SECRET, VERIFY_FAMILY_ID
 */
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import * as jwt from 'jsonwebtoken';
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

type LoginResponse = {
  data?: { accessToken?: string; familyId?: number };
  accessToken?: string;
  familyId?: number;
};

function decodeFamilyId(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    const id = Number(payload.familyId ?? payload.sub);
    return Number.isFinite(id) ? id : null;
  } catch {
    return null;
  }
}

async function loginParent(): Promise<{ token: string; familyId: number }> {
  const existing = process.env.PARENT_ACCESS_TOKEN;
  if (existing) {
    const familyId = Number(process.env.FAMILY_ID) || decodeFamilyId(existing);
    if (!familyId) throw new Error('FAMILY_ID required when using PARENT_ACCESS_TOKEN');
    return { token: existing, familyId };
  }

  const username = process.env.PARENT_USERNAME;
  const password = process.env.PARENT_PASSWORD;
  if (!username || !password) {
    throw new Error('Set PARENT_ACCESS_TOKEN or PARENT_USERNAME + PARENT_PASSWORD');
  }

  const res = await fetch(`${API_BASE_URL}/api/v1/auth/parent/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`Parent login failed: HTTP ${res.status}`);
  const body = (await res.json()) as LoginResponse;
  const data = body.data ?? body;
  const token = data.accessToken;
  const familyId = Number(process.env.FAMILY_ID ?? data.familyId);
  if (!token || !familyId) throw new Error('Parent login response missing token or familyId');
  return { token, familyId };
}

function signTestTokens(familyId: number): { parentToken: string; staffToken: string } {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is required to sign test tokens (set in .env or environment)');
  }

  const parentToken = jwt.sign(
    { sub: familyId, familyId, userType: 'PARENT' },
    secret,
    { expiresIn: '15m' },
  );

  const staffToken = jwt.sign(
    {
      sub: 'verify-chat-staff',
      username: 'verify-chat',
      role: 'ADMIN',
      campusId: null,
      allowedClassIds: [],
      userType: 'STAFF',
      permissions: ['chat:read', 'chat:write'],
    },
    secret,
    { expiresIn: '15m' },
  );

  return { parentToken, staffToken };
}

async function loginStaff(): Promise<string> {
  const existing = process.env.STAFF_ACCESS_TOKEN;
  if (existing) return existing;

  const username = process.env.STAFF_USERNAME;
  const password = process.env.STAFF_PASSWORD;
  if (!username || !password) {
    throw new Error('Set STAFF_ACCESS_TOKEN or STAFF_USERNAME + STAFF_PASSWORD');
  }

  const res = await fetch(`${API_BASE_URL}/api/v1/auth/staff/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`Staff login failed: HTTP ${res.status}`);
  const setCookie = res.headers.get('set-cookie') || '';
  const accessMatch = setCookie.match(/tafs_access=([^;]+)/);
  if (accessMatch?.[1]) return accessMatch[1];

  const body = (await res.json()) as { data?: { accessToken?: string }; accessToken?: string };
  const token = body.data?.accessToken ?? body.accessToken;
  if (!token) throw new Error('Staff login response missing access token');
  return token;
}

function connectSocket(token: string, label: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(SOCKET_URL, {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: false,
      timeout: 10000,
    });

    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`${label} socket connect timed out`));
    }, 12000);

    socket.on('connect', () => {
      clearTimeout(timer);
      console.log(`[verify] ${label} connected (${socket.id})`);
      resolve(socket);
    });

    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(new Error(`${label} connect_error: ${err.message}`));
    });
  });
}

function waitForEvent<T>(socket: Socket, event: string, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for "${event}"`));
    }, timeoutMs);

    const handler = (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    };

    socket.once(event, handler);
  });
}

function emitWithAck<T>(socket: Socket, event: string, payload: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Ack timeout for "${event}"`)), 10000);
    socket.emit(event, payload, (response: T) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

async function resolveCredentials(): Promise<{
  parentToken: string;
  staffToken: string;
  familyId: number;
}> {
  const hasParentCreds =
    process.env.PARENT_ACCESS_TOKEN ||
    (process.env.PARENT_USERNAME && process.env.PARENT_PASSWORD);
  const hasStaffCreds =
    process.env.STAFF_ACCESS_TOKEN ||
    (process.env.STAFF_USERNAME && process.env.STAFF_PASSWORD);

  if (hasParentCreds && hasStaffCreds) {
    const { token: parentToken, familyId } = await loginParent();
    const staffToken = await loginStaff();
    return { parentToken, staffToken, familyId };
  }

  const familyId = Number(process.env.FAMILY_ID || process.env.VERIFY_FAMILY_ID || 3469);
  if (!Number.isFinite(familyId)) {
    throw new Error('FAMILY_ID or VERIFY_FAMILY_ID must be a valid number');
  }

  const { parentToken, staffToken } = signTestTokens(familyId);
  console.log('[verify] Using JWT-signed test tokens (no login credentials provided)');
  return { parentToken, staffToken, familyId };
}

async function main() {
  console.log(`[verify] API: ${API_BASE_URL}`);
  console.log(`[verify] Socket: ${SOCKET_URL}`);

  const { parentToken, staffToken, familyId } = await resolveCredentials();
  console.log(`[verify] familyId=${familyId}`);

  const parentSocket = await connectSocket(parentToken, 'parent');
  const staffSocket = await connectSocket(staffToken, 'staff');

  const parentToStaff = waitForEvent<{ message?: { content?: string } }>(
    staffSocket,
    'receiveMessage',
    10000,
  );
  const parentMsg = `verify-parent-${Date.now()}`;
  const parentAck = await emitWithAck<{ id?: string; error?: string }>(parentSocket, 'sendMessage', {
    familyId,
    senderType: 'GUARDIAN',
    messageType: 'TEXT',
    content: parentMsg,
  });
  if (parentAck?.error) throw new Error(`Parent send failed: ${parentAck.error}`);
  const staffReceived = await parentToStaff;
  if (staffReceived?.message?.content !== parentMsg) {
    throw new Error('Staff did not receive parent message content');
  }
  console.log('[verify] parent → staff: OK');

  const staffToParent = waitForEvent<{ message?: { content?: string } }>(
    parentSocket,
    'receiveMessage',
    10000,
  );
  const staffMsg = `verify-staff-${Date.now()}`;
  const staffAck = await emitWithAck<{ id?: string; error?: string }>(staffSocket, 'sendMessage', {
    familyId,
    senderType: 'ADMIN',
    messageType: 'TEXT',
    content: staffMsg,
  });
  if (staffAck?.error) throw new Error(`Staff send failed: ${staffAck.error}`);
  const parentReceived = await staffToParent;
  if (parentReceived?.message?.content !== staffMsg) {
    throw new Error('Parent did not receive staff message content');
  }
  console.log('[verify] staff → parent: OK');

  parentSocket.disconnect();
  staffSocket.disconnect();
  console.log('[verify] Chat socket delivery verified successfully');
}

main().catch((err) => {
  console.error('[verify] FAILED:', err.message || err);
  process.exit(1);
});
