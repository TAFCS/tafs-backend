import { PDFDocument } from 'pdf-lib';
import {
  PAGE_HEIGHT,
  PAGE_WIDTH,
  SLC_TEMPLATES,
  fillLeavingCertificate,
  resolveSlcTemplate,
  type SlcCertificateData,
} from './slc-template';

/**
 * The leaving certificate is stamped onto the school's own pre-printed blanks,
 * so the things that can silently break it are a blank going missing on a
 * deploy (`slc-formats/` is a plain folder at the repo root, not something the
 * Nest build emits), a student landing on the wrong campus's sheet, and a
 * coordinate wandering off the page. All are cheap to assert; the visual
 * placement is not, and was verified by rendering each filled sheet against its
 * blank.
 */
describe('leaving-certificate templates', () => {
  const sample: SlcCertificateData = {
    cc: '10482',
    gr_number: 'AL-2211',
    slc_number: '271',
    name: { last: 'SIDDIQUI', first: 'MUHAMMAD', middle: 'HASSAN' },
    father_name: { last: 'SIDDIQUI', first: 'ABDUL', middle: 'REHMAN' },
    dob: { month: 'MARCH', day: '14', year: '2007' },
    nationality: 'PAKISTANI',
    gender: 'MALE',
    religion: 'MUSLIM',
    present_level: 'A2 CAMBRIDGE',
    reason_for_leaving: "ON PARENT'S REQUEST",
    day: 'TUESDAY',
    date: 'SEPTEMBER 15, 2026',
  };

  const templates = Object.values(SLC_TEMPLATES);

  describe('resolveSlcTemplate', () => {
    it.each([
      // campus wins over class
      [2, 18, 'tafsal-kaneez-fatima'],
      [2, 4, 'tafsal-kaneez-fatima'],
      [3, 15, 'tafsal-north-nazimabad'],
      [3, 21, 'tafsal-north-nazimabad'],
      // Gulistan-e-Jauhar: VI–X on TAFSS, everyone else on TAFSAL
      [1, 15, 'tafss-jauhar'],
      [1, 19, 'tafss-jauhar'],
      [1, 14, 'tafsal-jauhar'],
      [1, 20, 'tafsal-jauhar'],
      [1, 1, 'tafsal-jauhar'],
      [null, 17, 'tafss-jauhar'],
      [null, null, 'tafsal-jauhar'],
    ])('campus %s, class %s → %s', (campus_id, class_id, expected) => {
      expect(resolveSlcTemplate({ campus_id, class_id }).id).toBe(expected);
    });
  });

  it.each(templates.map((t) => [t.id, t] as const))(
    '%s: finds the blank and returns a single A4 page',
    async (_id, template) => {
      const bytes = await fillLeavingCertificate(sample, template);
      const doc = await PDFDocument.load(bytes);

      expect(doc.getPageCount()).toBe(1);
      const { width, height } = doc.getPage(0).getSize();
      expect(width).toBeCloseTo(PAGE_WIDTH, 1);
      expect(height).toBeCloseTo(PAGE_HEIGHT, 1);
    },
  );

  // Each branch ticks a different box or writes the OTHERS blank instead.
  it.each([
    ['MALE', 'MUSLIM'],
    ['FEMALE', 'CHRISTIAN'],
    ['FEMALE', 'HINDU'],
    ['', ''],
  ])('renders for gender=%s religion=%s', async (gender, religion) => {
    const bytes = await fillLeavingCertificate(
      { ...sample, gender, religion },
      SLC_TEMPLATES['tafsal-jauhar'],
    );
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });

  it('prints an empty blank where the API says it has no value', async () => {
    // getLeavingCertificateData hands back '—' for "nothing recorded". Printing
    // that literally on a certificate reads as a typo.
    const bytes = await fillLeavingCertificate(
      {
        ...sample,
        identification_marks: '—',
        last_school_attended: '—',
        detained_year: { from: '—', to: '—' },
      },
      SLC_TEMPLATES['tafss-jauhar'],
    );
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });

  it('still produces the certificate when the photograph is unreadable', async () => {
    const bytes = await fillLeavingCertificate(
      { ...sample, photograph_base64: 'data:image/png;base64,bm90LWFuLWltYWdl' },
      SLC_TEMPLATES['tafsal-jauhar'],
    );
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });

  it.each(templates.map((t) => [t.id, t] as const))(
    '%s: keeps every mapped rule and box inside the page',
    (id, { rules, boxes }) => {
      for (const [name, rule] of Object.entries(rules)) {
        const key = `${id}.${name}`;
        expect(`${key}:${rule.x0 >= 0 && rule.x1 <= PAGE_WIDTH}`).toBe(`${key}:true`);
        expect(`${key}:${rule.x1 > rule.x0}`).toBe(`${key}:true`);
        expect(`${key}:${rule.y > 0 && rule.y < PAGE_HEIGHT}`).toBe(`${key}:true`);
      }
      for (const [name, box] of Object.entries(boxes)) {
        const key = `${id}.${name}`;
        expect(`${key}:${box.x0 >= 0 && box.x1 <= PAGE_WIDTH}`).toBe(`${key}:true`);
        expect(`${key}:${box.x1 > box.x0}`).toBe(`${key}:true`);
        // `top` and `bottom` are both measured DOWN from the page's top edge, so
        // the bottom border is the larger number. Flipping them silently pushes
        // a value off the sheet instead of failing.
        expect(`${key}:${box.bottom > box.top}`).toBe(`${key}:true`);
        expect(`${key}:${box.bottom < PAGE_HEIGHT}`).toBe(`${key}:true`);
      }
    },
  );
});
