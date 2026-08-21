import { randomInt } from 'crypto';

/**
 * Builds a "name1.name2.name3" portal username from a full name — one dot-
 * separated, lowercased, alnum-only token per name part. Never produces an
 * "@tafs.com" style address.
 */
export function usernamePartsFromFullName(fullName: string): string[] {
  return fullName
    .trim()
    .split(/\s+/)
    .map((part) => part.toLowerCase().replace(/[^a-z0-9]/g, ''))
    .filter(Boolean);
}

export function baseUsernameFromFullName(fullName: string): string {
  const parts = usernamePartsFromFullName(fullName);
  return parts.length > 0 ? parts.join('.') : 'user';
}

/** Appends a numeric suffix to the last name part until the username is free. */
export function generateUniqueUsername(fullName: string, existingUsernames: Set<string>): string {
  const base = baseUsernameFromFullName(fullName);
  if (!existingUsernames.has(base.toLowerCase())) return base;

  let counter = 2;
  let candidate = `${base}${counter}`;
  while (existingUsernames.has(candidate.toLowerCase())) {
    counter++;
    candidate = `${base}${counter}`;
  }
  return candidate;
}

const PASSWORD_CHARS = {
  lower: 'abcdefghjkmnpqrstuvwxyz',
  upper: 'ABCDEFGHJKMNPQRSTUVWXYZ',
  digits: '23456789',
  symbols: '!@#$%&*',
};

/** Cryptographically random password, guaranteed to include each character class. */
export function generateSecurePassword(length = 10): string {
  const all = PASSWORD_CHARS.lower + PASSWORD_CHARS.upper + PASSWORD_CHARS.digits + PASSWORD_CHARS.symbols;
  const pick = (set: string) => set[randomInt(set.length)];

  const required = [
    pick(PASSWORD_CHARS.lower),
    pick(PASSWORD_CHARS.upper),
    pick(PASSWORD_CHARS.digits),
    pick(PASSWORD_CHARS.symbols),
  ];
  const rest = Array.from({ length: Math.max(length - required.length, 0) }, () => pick(all));

  const chars = [...required, ...rest];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/** True for the legacy "name@tafs.com" style username this feature replaces. */
export function isLegacyTafsEmailUsername(username: string): boolean {
  return /@tafs\.com$/i.test(username.trim());
}
