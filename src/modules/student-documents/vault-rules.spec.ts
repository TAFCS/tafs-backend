import { PDFDocument } from 'pdf-lib';
import {
  checkUploadBatch,
  guardiansExpectedFor,
  missingFor,
  normaliseMime,
  prepareUpload,
  requiredSlotCount,
  slug,
  type RequiredType,
} from './vault-rules';

const B_FORM: RequiredType = { id: 1, code: 'B_FORM', name: 'B-Form / CNIC', owner: 'STUDENT' };
const BIRTH: RequiredType = { id: 2, code: 'BIRTH_CERTIFICATE', name: 'Birth certificate', owner: 'STUDENT' };
const CNIC: RequiredType = { id: 3, code: 'GUARDIAN_CNIC', name: 'CNIC', owner: 'GUARDIAN' };

const father = { guardian_id: 10, relationship: 'Father', is_primary_contact: true };
const mother = { guardian_id: 11, relationship: 'MOTHER', is_primary_contact: false };
const uncle = { guardian_id: 12, relationship: 'UNCLE', is_primary_contact: false };

// 1x1 white PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
  'base64',
);
const file = (name: string, mimetype: string, buffer = PNG, size = buffer.length) => ({
  originalname: name,
  mimetype,
  buffer,
  size,
});

describe('vault rules', () => {
  describe('guardiansExpectedFor', () => {
    it('expects parent documents from every linked father and mother, whatever the case', () => {
      expect(guardiansExpectedFor([father, mother, uncle]).map((g) => g.guardian_id)).toEqual([10, 11]);
    });
    it('falls back to the primary contact when there is no father or mother', () => {
      expect(guardiansExpectedFor([uncle, { ...uncle, guardian_id: 13, is_primary_contact: true }]).map((g) => g.guardian_id)).toEqual([13]);
    });
    it('falls back to the first guardian, and to nobody when there are none', () => {
      expect(guardiansExpectedFor([uncle]).map((g) => g.guardian_id)).toEqual([12]);
      expect(guardiansExpectedFor([])).toEqual([]);
    });
  });

  describe('missingFor', () => {
    it("lists the student's own required documents and each parent's", () => {
      const missing = missingFor(500, [B_FORM, BIRTH, CNIC], [father, mother], [
        { type_id: 1, student_id: 500, guardian_id: null },
        { type_id: 3, student_id: null, guardian_id: 10 },
      ]);
      expect(missing.map((m) => m.label)).toEqual(['Birth certificate', "Mother's CNIC"]);
      expect(missing[1].guardian_id).toBe(11);
    });
    it("doesn't count another student's document", () => {
      const missing = missingFor(500, [B_FORM], [], [{ type_id: 1, student_id: 501, guardian_id: null }]);
      expect(missing).toHaveLength(1);
    });
    it('a sibling sharing the father counts his CNIC as on file', () => {
      expect(missingFor(501, [CNIC], [father], [{ type_id: 3, student_id: null, guardian_id: 10 }])).toEqual([]);
    });
    it('counts one required slot per expected guardian', () => {
      expect(requiredSlotCount([B_FORM, BIRTH, CNIC], [father, mother, uncle])).toBe(4);
      expect(requiredSlotCount([B_FORM, CNIC], [])).toBe(1);
    });
  });

  describe('checkUploadBatch', () => {
    it('accepts PDFs, JPGs and PNGs', () => {
      expect(checkUploadBatch([file('a.pdf', 'application/pdf'), file('b.jpg', 'image/jpeg'), file('c.png', 'image/png')])).toBeNull();
    });
    it('refuses other types, oversized files and empty batches', () => {
      expect(checkUploadBatch([])).toMatch(/Choose a file/);
      expect(checkUploadBatch([file('a.docx', 'application/msword')])).toMatch(/not a PDF/);
      expect(checkUploadBatch([file('a.pdf', 'application/pdf', PNG, 11 * 1024 * 1024)])).toMatch(/larger than 10 MB/);
      expect(
        checkUploadBatch([1, 2, 3].map((i) => file(`${i}.pdf`, 'application/pdf', PNG, 9 * 1024 * 1024))),
      ).toMatch(/25 MB/);
    });
    it('reads the extension when the browser sends no type', () => {
      expect(normaliseMime({ mimetype: 'application/octet-stream', originalname: 'scan.PDF' })).toBe('application/pdf');
      expect(normaliseMime({ mimetype: 'image/jpg', originalname: 'x' })).toBe('image/jpeg');
    });
  });

  describe('prepareUpload', () => {
    it('keeps a single image as it is', async () => {
      const out = await prepareUpload([file('photo.png', 'image/png')], 'b-form');
      expect(out.mime).toBe('image/png');
      expect(out.buffer.equals(PNG)).toBe(true);
      expect(out.sha256).toHaveLength(64);
    });

    it('combines several files into one PDF, a page per image plus every PDF page', async () => {
      const src = await PDFDocument.create();
      src.addPage();
      src.addPage();
      const pdf = Buffer.from(await src.save());
      const out = await prepareUpload(
        [file('p1.png', 'image/png'), file('p2.pdf', 'application/pdf', pdf), file('p3.png', 'image/png')],
        'scanned-form',
      );
      expect(out.mime).toBe('application/pdf');
      expect(out.pageCount).toBe(4);
      expect(out.filename).toBe('scanned-form.pdf');
      expect((await PDFDocument.load(out.buffer)).getPageCount()).toBe(4);
    });

    it('rejects a file that claims to be a PDF but is not', async () => {
      await expect(prepareUpload([file('x.pdf', 'application/pdf', Buffer.from('nope'))], 'x')).rejects.toThrow(
        /could not be read as a PDF/,
      );
    });
  });

  it('slugs names for keys and download names', () => {
    expect(slug("Father's CNIC")).toBe('father-s-cnic');
    expect(slug('***')).toBe('document');
  });
});
