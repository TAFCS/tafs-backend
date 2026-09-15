import { readFileSync } from 'fs';
import { join } from 'path';
import { PDFDocument, PDFPage, StandardFonts, rgb } from 'pdf-lib';

/**
 * TAFSAL Leaving Certificate — fills the school's own pre-printed blank.
 *
 * Every other segment's SLC is drawn from scratch by the webapp's
 * `LeavingCertificatePDF` component. TAFSAL is different: the school supplied a
 * finished A4 artwork (`slc-formats/slc-tafsal.pdf`) with its header, crests,
 * rules, boxes and footer already on the page, and the certificate must come out
 * as that exact sheet with the data typed onto it. So nothing is re-drawn here —
 * the template is loaded and values are stamped at the coordinates of its own
 * rules and boxes.
 *
 * COORDINATES. Every number below was measured off the template's content
 * stream, not eyeballed: the horizontal rules and box borders are real vector
 * segments and the labels are real text runs, so each field's line is known
 * exactly. They are all expressed as `yTop` — distance DOWN from the top edge,
 * the way the extraction reports them — and converted to pdf-lib's
 * bottom-left origin in one place (`baselineOnRule` / `centreInBox`). If the
 * artwork is ever re-exported, re-measure rather than nudging these by eye.
 */

export const PAGE_HEIGHT = 841.8898;
export const PAGE_WIDTH = 595.2756;

/** A value sits this far above the rule it is written on. */
const RULE_CLEARANCE = 2.4;

/**
 * And this far in from the rule's left end. Several of the form's rules begin
 * flush against — occasionally a hair before — the end of their own label, so a
 * value written at the rule's exact start reads as one word with the label
 * ("REMARKS :COMPLETED..."). This is the gap that keeps them apart.
 */
const RULE_INDENT = 3;

const DEFAULT_SIZE = 8;

/** One underlined blank: the rule's y (from the top) and its x extent. */
interface Rule {
  y: number;
  x0: number;
  x1: number;
}

/** One bordered box: both border y's (from the top) and its x extent. */
interface Box {
  top: number;
  bottom: number;
  x0: number;
  x1: number;
}

/**
 * The blank ships with a literal "-" typed into six places (three sidebar
 * boxes, the father's middle-name blank, identification marks and last school
 * attended). They are placeholders on an empty form, not separators, so they
 * are painted out before the real values land on top.
 *
 * The COMPUTER CODE box's dash is deliberately NOT in this list — there the
 * template reads "TAFSAL  -" and the dash separates the prefix from the code.
 */
const PLACEHOLDER_DASHES: { x0: number; x1: number; top: number; bottom: number }[] = [
  { x0: 112.0, x1: 121.0, top: 111.0, bottom: 127.5 }, // REGISTRATION # box
  { x0: 108.5, x1: 116.8, top: 389.0, bottom: 405.0 }, // G. R. # box
  { x0: 108.3, x1: 116.6, top: 540.8, bottom: 557.0 }, // S. L. C. # box
  { x0: 495.5, x1: 501.6, top: 121.6, bottom: 130.6 }, // FATHER'S NAME — MIDDLE
  { x0: 412.8, x1: 418.8, top: 291.1, bottom: 300.4 }, // MARK (S) OF IDENTIFICATION
  { x0: 411.5, x1: 417.4, top: 315.7, bottom: 324.0 }, // LAST SCHOOL ATTENDED
];

/** Underlined blanks, keyed by the field that is written on them. */
export const RULES = {
  nameLast:        { y: 102.09, x0: 268.81, x1: 340.28 },
  nameFirst:       { y: 102.09, x0: 361.38, x1: 432.85 },
  nameMiddle:      { y: 102.09, x0: 453.95, x1: 525.42 },

  fatherLast:      { y: 131.21, x0: 323.99, x1: 388.74 },
  fatherFirst:     { y: 131.21, x0: 395.70, x1: 456.38 },
  fatherMiddle:    { y: 131.21, x0: 465.99, x1: 526.67 },

  dobMonth:        { y: 160.01, x0: 269.46, x1: 340.31 },
  dobDay:          { y: 160.01, x0: 362.30, x1: 433.15 },
  dobYear:         { y: 160.01, x0: 455.14, x1: 525.99 },

  pobCountry:      { y: 189.32, x0: 269.46, x1: 340.31 },
  pobProvince:     { y: 189.32, x0: 362.30, x1: 433.15 },
  pobCity:         { y: 189.32, x0: 455.14, x1: 525.99 },

  nationality:     { y: 218.42, x0: 258.27, x1: 434.57 },
  religionOthers:  { y: 277.92, x0: 462.51, x1: 528.36 },

  identification:  { y: 301.64, x0: 318.88, x1: 528.36 },
  lastSchool:      { y: 324.99, x0: 302.06, x1: 528.36 },

  admissionMonth:  { y: 349.75, x0: 280.63, x1: 351.98 },
  admissionDay:    { y: 349.75, x0: 369.38, x1: 440.73 },
  admissionYear:   { y: 349.75, x0: 457.01, x1: 528.36 },

  presentLevel:    { y: 432.89, x0: 263.48, x1: 373.57 },
  section:         { y: 432.89, x0: 417.37, x1: 528.36 },

  attendanceMonth: { y: 498.09, x0: 199.76, x1: 286.15 },
  attendanceDay:   { y: 498.09, x0: 321.26, x1: 407.66 },
  attendanceYear:  { y: 498.09, x0: 441.96, x1: 528.36 },

  reasonLeaving:   { y: 526.53, x0: 322.78, x1: 528.36 },

  promotedLevel:   { y: 573.53, x0: 332.62, x1: 360.98 },
  resitSubjects:   { y: 598.00, x0: 443.43, x1: 528.36 },
  resitOverflow:   { y: 623.12, x0: 200.34, x1: 528.36 },
  detainedLevel:   { y: 646.50, x0: 293.57, x1: 350.57 },

  dues:            { y: 670.83, x0: 294.08, x1: 528.36 },
  remarks:         { y: 694.86, x0: 240.93, x1: 526.11 },

  preparedBy:      { y: 719.11, x0: 261.00, x1: 310.91 },
  recheckedBy:     { y: 719.11, x0: 382.12, x1: 430.87 },
  postedBy:        { y: 719.11, x0: 483.37, x1: 528.36 },

  leadTeacher:     { y: 743.21, x0: 274.68, x1: 345.23 },
  directress:      { y: 743.07, x0: 463.31, x1: 528.36 },

  day:             { y: 767.34, x0: 218.06, x1: 315.97 },
  date:            { y: 767.34, x0: 347.81, x1: 528.32 },
} satisfies Record<string, Rule>;

/** Bordered boxes. */
export const BOXES = {
  registration:      { top: 105.39, bottom: 130.04, x0: 71.40, x1: 178.56 },
  computerCode:      { top: 247.82, bottom: 272.47, x0: 71.40, x1: 178.56 },
  grNumber:          { top: 383.06, bottom: 407.72, x0: 71.40, x1: 178.56 },
  slcNumber:         { top: 534.26, bottom: 558.92, x0: 71.40, x1: 178.56 },
  photo:             { top: 651.85, bottom: 790.69, x0: 65.84, x1: 184.91 },

  admittedYearFrom:  { top: 375.64, bottom: 387.78, x0: 277.77, x1: 299.37 },
  admittedYearTo:    { top: 375.64, bottom: 387.78, x0: 310.27, x1: 331.87 },
  levelAdmitted:     { top: 398.58, bottom: 410.72, x0: 385.03, x1: 406.63 },
  presentYearFrom:   { top: 447.12, bottom: 459.26, x0: 277.77, x1: 299.37 },
  presentYearTo:     { top: 447.12, bottom: 459.26, x0: 310.27, x1: 331.87 },
  resultYearFrom:    { top: 540.25, bottom: 552.39, x0: 392.26, x1: 413.86 },
  resultYearTo:      { top: 540.25, bottom: 552.39, x0: 424.75, x1: 446.35 },
  promotedYearFrom:  { top: 563.67, bottom: 575.81, x0: 474.26, x1: 495.86 },
  promotedYearTo:    { top: 563.67, bottom: 575.81, x0: 506.76, x1: 528.36 },
  detainedYearFrom:  { top: 635.47, bottom: 647.61, x0: 474.26, x1: 495.86 },
  detainedYearTo:    { top: 635.47, bottom: 647.61, x0: 506.76, x1: 528.36 },

  sexMale:           { top: 243.69, bottom: 255.83, x0: 266.50, x1: 288.10 },
  sexFemale:         { top: 243.69, bottom: 255.83, x0: 337.55, x1: 359.15 },
  religionMuslim:    { top: 268.24, bottom: 280.37, x0: 266.50, x1: 288.10 },
  religionChristian: { top: 268.24, bottom: 280.37, x0: 337.55, x1: 359.15 },
} satisfies Record<string, Box>;

/**
 * The blank arrives with MALE and MUSLIM already ticked — convenient for the
 * common case and wrong for everyone else, and a tick cannot be un-drawn. Both
 * pre-printed ticks are therefore always painted out, their boxes re-stroked,
 * and the correct tick drawn from scratch. The tick artwork overhangs the top
 * of its box, so these cover a taller band than the box itself.
 */
const PRINTED_TICKS = [
  { x0: 264.8, x1: 292.2, top: 233.8, bottom: 257.2, box: BOXES.sexMale },
  { x0: 264.8, x1: 292.2, top: 258.4, bottom: 281.6, box: BOXES.religionMuslim },
];

export interface TafsalNameParts {
  last?: string | null;
  first?: string | null;
  middle?: string | null;
}

export interface TafsalDateParts {
  month?: string | null;
  day?: string | null;
  year?: string | null;
}

export interface TafsalYearParts {
  from?: string | null;
  to?: string | null;
}

/** Exactly the payload `getLeavingCertificateData` returns, plus the two
 *  fields only the operator can supply. */
export interface TafsalCertificateData {
  registration_number?: string | null;
  cc?: number | string | null;
  gr_number?: string | null;
  slc_number?: string | null;
  name?: TafsalNameParts;
  father_name?: TafsalNameParts;
  dob?: TafsalDateParts;
  place_of_birth?: { country?: string | null; province?: string | null; city?: string | null };
  nationality?: string | null;
  gender?: string | null;
  religion?: string | null;
  identification_marks?: string | null;
  last_school_attended?: string | null;
  date_of_admission?: TafsalDateParts;
  scholastic_year_admitted?: TafsalYearParts;
  class_admitted?: string | null;
  present_level?: string | null;
  section?: string | null;
  scholastic_year_present?: TafsalYearParts;
  last_date_of_attendance?: TafsalDateParts;
  reason_for_leaving?: string | null;
  result_scholastic_year?: TafsalYearParts;
  passed_promoted_level?: string | null;
  passed_promoted_year?: TafsalYearParts;
  resit_subjects?: string | null;
  detained_level?: string | null;
  detained_year?: TafsalYearParts;
  school_dues?: string | null;
  remarks?: string | null;
  prepared_by?: string | null;
  rechecked_by?: string | null;
  posted_by?: string | null;
  class_teacher?: string | null;
  programme_directress?: string | null;
  day?: string | null;
  date?: string | null;
  /** Data URL or bare base64. The webapp already holds the decoded photo. */
  photograph_base64?: string | null;
}

/**
 * An em-dash is what the API hands back for "we have no value". On a printed
 * certificate that reads as a typo, so it prints as an empty blank instead.
 */
const clean = (value: unknown): string => {
  const s = value == null ? '' : String(value).trim();
  return s === '—' || s === '-' || s === 'N/A' ? '' : s;
};

const resolveTemplatePath = (): string => {
  // process.cwd() is the repo root under `nest start` and on the deployed box
  // alike; the __dirname hop is the fallback for a build run from elsewhere.
  const candidates = [
    join(process.cwd(), 'slc-formats', 'slc-tafsal.pdf'),
    join(__dirname, '..', '..', '..', 'slc-formats', 'slc-tafsal.pdf'),
  ];
  for (const path of candidates) {
    try {
      readFileSync(path);
      return path;
    } catch {
      /* try the next one */
    }
  }
  throw new Error(
    `TAFSAL leaving-certificate template not found. Looked in: ${candidates.join(', ')}`,
  );
};

export async function fillTafsalLeavingCertificate(
  data: TafsalCertificateData,
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(readFileSync(resolveTemplatePath()));
  const page = pdfDoc.getPage(0);
  // Helvetica-Bold against the template's Times labels: a filled value should
  // read as filled in, not as more of the pre-printed form.
  const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const white = rgb(1, 1, 1);
  const ink = rgb(0, 0, 0);

  const cover = (r: { x0: number; x1: number; top: number; bottom: number }) =>
    page.drawRectangle({
      x: r.x0,
      y: PAGE_HEIGHT - r.bottom,
      width: r.x1 - r.x0,
      height: r.bottom - r.top,
      color: white,
    });

  PLACEHOLDER_DASHES.forEach(cover);

  /**
   * Shrinks a value until it fits its blank. Names, remarks and a reason for
   * leaving are free text and routinely overrun the space the form gives them;
   * spilling into the neighbouring column is worse than a smaller line.
   */
  const fit = (value: string, maxWidth: number, size: number) => {
    let s = size;
    while (s > 4.5 && font.widthOfTextAtSize(value, s) > maxWidth) s -= 0.25;
    return s;
  };

  /** Writes a value sitting on an underlined blank, left-aligned to its rule. */
  const onRule = (rule: Rule, value: unknown, size = DEFAULT_SIZE) => {
    const text = clean(value);
    if (!text) return;
    const width = rule.x1 - rule.x0;
    const fontSize = fit(text, width - RULE_INDENT, size);
    page.drawText(text, {
      x: rule.x0 + RULE_INDENT,
      y: PAGE_HEIGHT - rule.y + RULE_CLEARANCE,
      size: fontSize,
      font,
      color: ink,
    });
  };

  /** Writes a value centred inside a bordered box. */
  const inBox = (box: Box, value: unknown, size = DEFAULT_SIZE) => {
    const text = clean(value);
    if (!text) return;
    const width = box.x1 - box.x0;
    const fontSize = fit(text, width - 4, size);
    const textWidth = font.widthOfTextAtSize(text, fontSize);
    const boxHeight = box.bottom - box.top;
    page.drawText(text, {
      x: box.x0 + (width - textWidth) / 2,
      y: PAGE_HEIGHT - box.bottom + (boxHeight - fontSize * 0.72) / 2,
      size: fontSize,
      font,
      color: ink,
    });
  };

  /** Draws the two strokes of a tick inside a box. */
  const tick = (box: Box) => {
    const w = box.x1 - box.x0;
    const h = box.bottom - box.top;
    const left = box.x0 + w * 0.22;
    const mid = box.x0 + w * 0.42;
    const right = box.x1 - w * 0.13;
    const yBottom = PAGE_HEIGHT - box.bottom;
    const opts = { thickness: 1.5, color: ink };
    page.drawLine({
      start: { x: left, y: yBottom + h * 0.55 },
      end: { x: mid, y: yBottom + h * 0.22 },
      ...opts,
    });
    page.drawLine({
      start: { x: mid, y: yBottom + h * 0.22 },
      end: { x: right, y: yBottom + h * 0.88 },
      ...opts,
    });
  };

  // ── Sidebar boxes ────────────────────────────────────────────────────────
  inBox(BOXES.registration, data.registration_number, 11);
  inBox(BOXES.grNumber, data.gr_number, 11);
  inBox(BOXES.slcNumber, data.slc_number, 11);
  // The template already prints "TAFSAL  -" in this box; only the code itself
  // is missing, so it is written after the dash rather than centred.
  const computerCode = clean(data.cc);
  if (computerCode) {
    const codeX = 148;
    const codeSize = fit(computerCode, BOXES.computerCode.x1 - codeX - 4, 11);
    page.drawText(computerCode, {
      x: codeX,
      y: PAGE_HEIGHT - 266.8,
      size: codeSize,
      font,
      color: ink,
    });
  }

  // ── Identity ─────────────────────────────────────────────────────────────
  onRule(RULES.nameLast, data.name?.last);
  onRule(RULES.nameFirst, data.name?.first);
  onRule(RULES.nameMiddle, data.name?.middle);

  onRule(RULES.fatherLast, data.father_name?.last);
  onRule(RULES.fatherFirst, data.father_name?.first);
  onRule(RULES.fatherMiddle, data.father_name?.middle);

  onRule(RULES.dobMonth, data.dob?.month);
  onRule(RULES.dobDay, data.dob?.day);
  onRule(RULES.dobYear, data.dob?.year);

  onRule(RULES.pobCountry, data.place_of_birth?.country);
  onRule(RULES.pobProvince, data.place_of_birth?.province);
  onRule(RULES.pobCity, data.place_of_birth?.city);

  onRule(RULES.nationality, data.nationality);

  // ── Sex / religion ───────────────────────────────────────────────────────
  for (const printed of PRINTED_TICKS) {
    cover(printed);
    page.drawRectangle({
      x: printed.box.x0,
      y: PAGE_HEIGHT - printed.box.bottom,
      width: printed.box.x1 - printed.box.x0,
      height: printed.box.bottom - printed.box.top,
      borderColor: ink,
      borderWidth: 0.9,
    });
  }

  const gender = clean(data.gender).toUpperCase();
  tick(gender.startsWith('F') ? BOXES.sexFemale : BOXES.sexMale);

  const religion = clean(data.religion).toUpperCase();
  if (religion.startsWith('CHRIST')) {
    tick(BOXES.religionChristian);
  } else if (!religion || religion.startsWith('MUSLIM') || religion.startsWith('ISLAM')) {
    tick(BOXES.religionMuslim);
  } else {
    // Anything else belongs on the OTHERS blank, with neither box ticked.
    onRule(RULES.religionOthers, religion);
  }

  onRule(RULES.identification, data.identification_marks);
  onRule(RULES.lastSchool, data.last_school_attended);

  // ── Admission ────────────────────────────────────────────────────────────
  onRule(RULES.admissionMonth, data.date_of_admission?.month);
  onRule(RULES.admissionDay, data.date_of_admission?.day);
  onRule(RULES.admissionYear, data.date_of_admission?.year);

  inBox(BOXES.admittedYearFrom, data.scholastic_year_admitted?.from, 7);
  inBox(BOXES.admittedYearTo, data.scholastic_year_admitted?.to, 7);
  inBox(BOXES.levelAdmitted, data.class_admitted, 7);

  onRule(RULES.presentLevel, data.present_level);
  onRule(RULES.section, data.section);
  inBox(BOXES.presentYearFrom, data.scholastic_year_present?.from, 7);
  inBox(BOXES.presentYearTo, data.scholastic_year_present?.to, 7);

  // ── Leaving ──────────────────────────────────────────────────────────────
  onRule(RULES.attendanceMonth, data.last_date_of_attendance?.month);
  onRule(RULES.attendanceDay, data.last_date_of_attendance?.day);
  onRule(RULES.attendanceYear, data.last_date_of_attendance?.year);

  onRule(RULES.reasonLeaving, data.reason_for_leaving);

  inBox(BOXES.resultYearFrom, data.result_scholastic_year?.from, 7);
  inBox(BOXES.resultYearTo, data.result_scholastic_year?.to, 7);

  onRule(RULES.promotedLevel, data.passed_promoted_level, 7);
  inBox(BOXES.promotedYearFrom, data.passed_promoted_year?.from, 7);
  inBox(BOXES.promotedYearTo, data.passed_promoted_year?.to, 7);

  // The form gives resit subjects a short tail after its label and a full-width
  // second line; a long list uses the wide line rather than being squeezed.
  const resit = clean(data.resit_subjects);
  if (resit) {
    if (font.widthOfTextAtSize(resit, DEFAULT_SIZE) <= RULES.resitSubjects.x1 - RULES.resitSubjects.x0) {
      onRule(RULES.resitSubjects, resit);
    } else {
      onRule(RULES.resitOverflow, resit);
    }
  }

  onRule(RULES.detainedLevel, data.detained_level, 7);
  inBox(BOXES.detainedYearFrom, data.detained_year?.from, 7);
  inBox(BOXES.detainedYearTo, data.detained_year?.to, 7);

  // ── Footer ───────────────────────────────────────────────────────────────
  onRule(RULES.dues, data.school_dues);
  onRule(RULES.remarks, data.remarks);
  onRule(RULES.preparedBy, data.prepared_by, 7);
  onRule(RULES.recheckedBy, data.rechecked_by, 7);
  onRule(RULES.postedBy, data.posted_by, 7);
  onRule(RULES.leadTeacher, data.class_teacher, 7);
  onRule(RULES.directress, data.programme_directress, 7);
  onRule(RULES.day, data.day);
  onRule(RULES.date, data.date);

  await drawPhotograph(pdfDoc, page, data.photograph_base64);

  return pdfDoc.save();
}

/**
 * Fits the student photo inside the sidebar box, preserving aspect ratio and
 * centring the remainder. A photo that cannot be decoded is skipped: an SLC
 * without a picture is still a valid SLC, a failed request is not.
 */
async function drawPhotograph(
  pdfDoc: PDFDocument,
  page: PDFPage,
  base64: string | null | undefined,
): Promise<void> {
  if (!base64) return;
  try {
    const isPng = base64.includes('image/png') || base64.startsWith('iVBOR');
    const payload = base64.includes(',') ? base64.split(',')[1] : base64;
    const bytes = Buffer.from(payload, 'base64');
    const image = isPng ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);

    const box = BOXES.photo;
    const maxW = box.x1 - box.x0 - 6;
    const maxH = box.bottom - box.top - 6;
    const scale = Math.min(maxW / image.width, maxH / image.height);
    const w = image.width * scale;
    const h = image.height * scale;

    page.drawImage(image, {
      x: box.x0 + (box.x1 - box.x0 - w) / 2,
      y: PAGE_HEIGHT - box.bottom + (box.bottom - box.top - h) / 2,
      width: w,
      height: h,
    });
  } catch {
    /* unreadable photo — print the certificate without it */
  }
}
