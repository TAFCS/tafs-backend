import { createHash } from 'crypto';
import { PDFDocument } from 'pdf-lib';

/**
 * Student document vault (Academics plan §5). Pure rules, no database: what
 * counts as missing, which uploads are accepted, and how several scans become
 * one PDF. Kept apart so they can be unit-tested.
 */

export const VAULT_TILE = 'student.documents';
export const vaultAction = (id: string) => `${VAULT_TILE}#${id}`;

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
export const MAX_FILES_PER_UPLOAD = 20;

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png']);
const PDF_MIME = 'application/pdf';

export type UploadFile = { buffer: Buffer; mimetype: string; originalname: string; size: number };

export type PreparedFile = {
  buffer: Buffer;
  mime: string;
  extension: string;
  filename: string;
  pageCount: number | null;
  sha256: string;
};

/** Normalises the few aliases browsers and phones send. */
export function normaliseMime(file: Pick<UploadFile, 'mimetype' | 'originalname'>): string {
  const mime = (file.mimetype || '').toLowerCase();
  if (mime === 'image/jpg' || mime === 'image/pjpeg') return 'image/jpeg';
  if (mime === 'application/octet-stream' || !mime) {
    const ext = file.originalname.split('.').pop()?.toLowerCase();
    if (ext === 'pdf') return PDF_MIME;
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'png') return 'image/png';
  }
  return mime;
}

/** Returns an error message, or null when the batch is acceptable. */
export function checkUploadBatch(files: UploadFile[]): string | null {
  if (!files.length) return 'Choose a file to upload';
  if (files.length > MAX_FILES_PER_UPLOAD) return `Upload at most ${MAX_FILES_PER_UPLOAD} files at once`;
  let total = 0;
  for (const f of files) {
    const mime = normaliseMime(f);
    if (mime !== PDF_MIME && !IMAGE_MIMES.has(mime)) {
      return `${f.originalname} is not a PDF, JPG or PNG`;
    }
    if (f.size > MAX_FILE_BYTES) return `${f.originalname} is larger than 10 MB`;
    total += f.size;
  }
  if (total > MAX_TOTAL_BYTES) return 'The files add up to more than 25 MB';
  return null;
}

export const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

const A4 = { w: 595.28, h: 841.89 };

/**
 * One file stays as it is. Several files (a form photographed page by page, or
 * a PDF plus a photo) become one PDF, in the order given: each image on its own
 * A4 page, scaled to fit; each PDF's pages copied across.
 */
export async function prepareUpload(files: UploadFile[], baseName: string): Promise<PreparedFile> {
  if (files.length === 1) {
    const f = files[0];
    const mime = normaliseMime(f);
    const extension = mime === PDF_MIME ? 'pdf' : mime === 'image/png' ? 'png' : 'jpg';
    let pageCount: number | null = mime === PDF_MIME ? null : 1;
    if (mime === PDF_MIME) {
      try {
        pageCount = (await PDFDocument.load(f.buffer, { ignoreEncryption: true })).getPageCount();
      } catch {
        throw new Error(`${f.originalname} could not be read as a PDF`);
      }
    }
    return {
      buffer: f.buffer,
      mime,
      extension,
      filename: f.originalname || `${baseName}.${extension}`,
      pageCount,
      sha256: sha256(f.buffer),
    };
  }

  const out = await PDFDocument.create();
  for (const f of files) {
    const mime = normaliseMime(f);
    if (mime === PDF_MIME) {
      let src: PDFDocument;
      try {
        src = await PDFDocument.load(f.buffer, { ignoreEncryption: true });
      } catch {
        throw new Error(`${f.originalname} could not be read as a PDF`);
      }
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach((p) => out.addPage(p));
      continue;
    }
    const img = mime === 'image/png' ? await out.embedPng(f.buffer) : await out.embedJpg(f.buffer);
    const landscape = img.width > img.height;
    const pw = landscape ? A4.h : A4.w;
    const ph = landscape ? A4.w : A4.h;
    const margin = 18;
    const scale = Math.min((pw - margin * 2) / img.width, (ph - margin * 2) / img.height, 1.5);
    const w = img.width * scale;
    const h = img.height * scale;
    const page = out.addPage([pw, ph]);
    page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  }
  const buffer = Buffer.from(await out.save());
  return {
    buffer,
    mime: PDF_MIME,
    extension: 'pdf',
    filename: `${baseName}.pdf`,
    pageCount: out.getPageCount(),
    sha256: sha256(buffer),
  };
}

// ─── What is missing ──────────────────────────────────────────────────────

export type RequiredType = { id: number; code: string; name: string; owner: string };
export type GuardianLink = { guardian_id: number; relationship: string | null; is_primary_contact: boolean | null; full_name?: string | null };
export type HeldDoc = { type_id: number; student_id: number | null; guardian_id: number | null };

export type MissingItem = {
  type_id: number;
  type_code: string;
  type_name: string;
  guardian_id: number | null;
  /** "B-Form / CNIC", or "Father's CNIC". */
  label: string;
};

const PARENT_RELATIONS = new Set(['FATHER', 'MOTHER']);

const titleCase = (s: string) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Which guardians a required parent document is expected from: every linked
 * father and mother. A student with neither (raised by an uncle, say) is
 * expected to have it from the primary contact, else from the first guardian.
 */
export function guardiansExpectedFor(links: GuardianLink[]): GuardianLink[] {
  const parents = links.filter((l) => PARENT_RELATIONS.has((l.relationship ?? '').trim().toUpperCase()));
  if (parents.length) return parents;
  const primary = links.find((l) => l.is_primary_contact);
  if (primary) return [primary];
  return links.slice(0, 1);
}

/** Required documents a student does not have on file yet (archived ones don't count). */
export function missingFor(
  cc: number,
  required: RequiredType[],
  links: GuardianLink[],
  held: HeldDoc[],
): MissingItem[] {
  const missing: MissingItem[] = [];
  const expectedGuardians = guardiansExpectedFor(links);
  for (const t of required) {
    if (t.owner === 'GUARDIAN') {
      for (const g of expectedGuardians) {
        const has = held.some((d) => d.type_id === t.id && d.guardian_id === g.guardian_id);
        if (!has) {
          const rel = (g.relationship ?? '').trim();
          missing.push({
            type_id: t.id,
            type_code: t.code,
            type_name: t.name,
            guardian_id: g.guardian_id,
            label: rel ? `${titleCase(rel)}'s ${t.name}` : `Guardian's ${t.name}`,
          });
        }
      }
      continue;
    }
    const has = held.some((d) => d.type_id === t.id && d.student_id === cc);
    if (!has) {
      missing.push({ type_id: t.id, type_code: t.code, type_name: t.name, guardian_id: null, label: t.name });
    }
  }
  return missing;
}

/** How many required slots a student has, counting one per expected guardian. */
export function requiredSlotCount(required: RequiredType[], links: GuardianLink[]): number {
  const guardians = guardiansExpectedFor(links).length;
  return required.reduce((n, t) => n + (t.owner === 'GUARDIAN' ? guardians : 1), 0);
}

/** "Father's CNIC" → "fathers-cnic". For storage keys and download names. */
export function slug(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60) || 'document';
}
