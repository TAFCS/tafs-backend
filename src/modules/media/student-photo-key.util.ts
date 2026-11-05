import { createHash } from 'node:crypto';

/**
 * Shared naming rules for student photo objects in Spaces (TAFSD-483).
 *
 * Every upload is a new object, never an overwrite, so the photo history keeps
 * working links to older photos. The key carries the upload time and a short
 * content hash: the time keeps keys unique, the hash lets a re-run of the same
 * batch recognise a photo it has already stored.
 *
 *   media/students/{cc}/standard-{epochMs}-{hash12}.{ext}
 */

export const STUDENT_PHOTO_EXTENSIONS = ['jpg', 'jpeg', 'png'] as const;
const HASH_LENGTH = 12;

export function photoContentHash(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex').slice(0, HASH_LENGTH);
}

export function studentPhotoKey(
  cc: number,
  type: 'standard' | 'blue_bg',
  ext: string,
  hash?: string,
  at: Date = new Date(),
): string {
  const suffix = hash ? `-${hash}` : '';
  return `media/students/${cc}/${type}-${at.getTime()}${suffix}.${ext.toLowerCase()}`;
}

/** True when a stored URL is the object written for this content hash. */
export function urlHasContentHash(url: string, hash: string): boolean {
  return url.includes(`-${hash}.`);
}

export function mimeForExtension(ext: string): string {
  return ext.toLowerCase() === 'png' ? 'image/png' : 'image/jpeg';
}

/**
 * Bulk-upload filenames are the student's CC and nothing else: "1234.jpg",
 * "1234.png". Returns the CC and extension, or null when the name does not
 * follow that rule.
 */
export function parseCcFilename(filename: string): { cc: number; ext: string } | null {
  const base = filename.split(/[\\/]/).pop()!.trim();
  const m = base.match(/^(\d{1,9})\.(jpe?g|png)$/i);
  if (!m) return null;
  const cc = parseInt(m[1], 10);
  if (!cc) return null;
  return { cc, ext: m[2].toLowerCase() };
}
