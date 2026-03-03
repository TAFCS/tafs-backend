import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';

export async function hashValue(value: string, rounds = 10): Promise<string> {
  return bcrypt.hash(value, rounds);
}

export async function compareHash(
  value: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(value, hash);
}

export function generateRandomToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

