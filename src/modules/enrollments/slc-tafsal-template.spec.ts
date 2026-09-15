import { PDFDocument } from 'pdf-lib';
import {
  BOXES,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  RULES,
  fillTafsalLeavingCertificate,
  type TafsalCertificateData,
} from './slc-tafsal-template';

/**
 * The TAFSAL leaving certificate is stamped onto the school's own pre-printed
 * blank, so the two things that can silently break it are the template going
 * missing on a deploy (`slc-formats/` is a plain folder at the repo root, not
 * something the Nest build emits) and a coordinate wandering off the page.
 * Both are cheap to assert; the visual placement is not, and was verified by
 * rendering the filled sheet against the blank.
 */
describe('TAFSAL leaving-certificate template', () => {
  const sample: TafsalCertificateData = {
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

  it('finds the blank and returns a single A4 page', async () => {
    const bytes = await fillTafsalLeavingCertificate(sample);
    const doc = await PDFDocument.load(bytes);

    expect(doc.getPageCount()).toBe(1);
    const { width, height } = doc.getPage(0).getSize();
    expect(width).toBeCloseTo(PAGE_WIDTH, 1);
    expect(height).toBeCloseTo(PAGE_HEIGHT, 1);
  });

  // MALE and MUSLIM come pre-ticked on the blank and every branch has to paint
  // them out before ticking, so each one exercises a different set of draws.
  it.each([
    ['MALE', 'MUSLIM'],
    ['FEMALE', 'CHRISTIAN'],
    ['FEMALE', 'HINDU'],
    ['', ''],
  ])('renders for gender=%s religion=%s', async (gender, religion) => {
    const bytes = await fillTafsalLeavingCertificate({ ...sample, gender, religion });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });

  it('prints an empty blank where the API says it has no value', async () => {
    // getLeavingCertificateData hands back '—' for "nothing recorded". Printing
    // that literally on a certificate reads as a typo.
    const bytes = await fillTafsalLeavingCertificate({
      ...sample,
      identification_marks: '—',
      last_school_attended: '—',
      detained_year: { from: '—', to: '—' },
    });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });

  it('still produces the certificate when the photograph is unreadable', async () => {
    const bytes = await fillTafsalLeavingCertificate({
      ...sample,
      photograph_base64: 'data:image/png;base64,bm90LWFuLWltYWdl',
    });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });

  it('keeps every mapped rule and box inside the page', () => {
    for (const [name, rule] of Object.entries(RULES)) {
      expect(`${name}:${rule.x0 >= 0 && rule.x1 <= PAGE_WIDTH}`).toBe(`${name}:true`);
      expect(`${name}:${rule.x1 > rule.x0}`).toBe(`${name}:true`);
      expect(`${name}:${rule.y > 0 && rule.y < PAGE_HEIGHT}`).toBe(`${name}:true`);
    }
    for (const [name, box] of Object.entries(BOXES)) {
      expect(`${name}:${box.x0 >= 0 && box.x1 <= PAGE_WIDTH}`).toBe(`${name}:true`);
      expect(`${name}:${box.x1 > box.x0}`).toBe(`${name}:true`);
      // `top` and `bottom` are both measured DOWN from the page's top edge, so
      // the bottom border is the larger number. Flipping them silently pushes a
      // value off the sheet instead of failing.
      expect(`${name}:${box.bottom > box.top}`).toBe(`${name}:true`);
      expect(`${name}:${box.bottom < PAGE_HEIGHT}`).toBe(`${name}:true`);
    }
  });
});
