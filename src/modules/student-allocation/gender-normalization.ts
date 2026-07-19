export type NormalizedGender = 'MALE' | 'FEMALE' | 'UNKNOWN';

const MALE_VALUES = new Set([
  'm',
  'male',
  'boy',
  'boys',
  'man',
  'men',
]);

const FEMALE_VALUES = new Set([
  'f',
  'female',
  'girl',
  'girls',
  'woman',
  'women',
]);

export function normalizeGender(raw: string | null | undefined): NormalizedGender {
  if (raw == null) return 'UNKNOWN';
  const value = String(raw).trim().toLowerCase();
  if (!value) return 'UNKNOWN';
  if (MALE_VALUES.has(value)) return 'MALE';
  if (FEMALE_VALUES.has(value)) return 'FEMALE';
  return 'UNKNOWN';
}

export function isMaleGender(raw: string | null | undefined): boolean {
  return normalizeGender(raw) === 'MALE';
}

export function isFemaleGender(raw: string | null | undefined): boolean {
  return normalizeGender(raw) === 'FEMALE';
}
