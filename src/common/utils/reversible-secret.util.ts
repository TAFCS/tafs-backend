import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/**
 * Reversible encryption for values that must be shown back to an admin later
 * (e.g. a portal password an admin can "reveal"). Not a substitute for the
 * one-way bcrypt hash used at login — this is stored alongside it purely so
 * the plaintext can be recovered on demand.
 *
 * Key is derived from JWT_SECRET so no extra secret needs provisioning.
 */
const ALGORITHM = 'aes-256-gcm';

function getKey(): Buffer {
  const source = process.env.JWT_SECRET;
  if (!source) throw new Error('JWT_SECRET must be set to use reversible secret encryption');
  return createHash('sha256').update(source).digest();
}

export function encryptSecret(plainText: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), encrypted.toString('base64')].join('.');
}

export function decryptSecret(payload: string): string {
  const [ivB64, authTagB64, dataB64] = payload.split('.');
  if (!ivB64 || !authTagB64 || !dataB64) throw new Error('Malformed encrypted payload');
  const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}
