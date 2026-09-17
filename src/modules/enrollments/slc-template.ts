import { readFileSync } from 'fs';
import { join } from 'path';
import { PDFDocument, PDFPage, StandardFonts, rgb } from 'pdf-lib';

/**
 * Leaving Certificate — fills the school's own pre-printed blanks.
 *
 * The school supplied finished A4 artwork for the certificate
 * (`slc-formats/slc-*.pdf`), one sheet per campus / segment, each with its
 * header, crests, rules, boxes and campus footer already on the page. The
 * certificate must come out as that exact sheet with the data typed onto it, so
 * nothing is re-drawn here — the blank is loaded and values are stamped at the
 * coordinates of its own rules and boxes.
 *
 * WHICH BLANK. `resolveSlcTemplate` — campus first, then class:
 *   - Kaneez Fatima campus, any class  → slc-tafsal-kaneez-fatima.pdf
 *   - North Nazimabad campus, any class → slc-tafsal-north-nazimabad.pdf
 *   - classes 15–19 (VI–X, Secondary)   → slc-tafss-jauhar.pdf
 *   - everyone else                      → slc-tafsal-jauhar.pdf
 *
 * COORDINATES. Every number below was measured off the blanks' content streams,
 * not eyeballed: the horizontal rules and box borders are real vector segments
 * and the labels are real text runs, so each field's line is known exactly.
 * They are all expressed as `yTop` — distance DOWN from the top edge, the way
 * the extraction reports them — and converted to pdf-lib's bottom-left origin
 * in one place (`onRule` / `inBox`, both of which centre the value). The three
 * TAFSAL blanks share one layout to the hundredth of a point; the TAFSS blank
 * re-typesets a few labels (LEVEL → CLASS, TAFSAL → TAFSS) and its rules start
 * slightly differently, so it carries its own overrides. If the artwork is ever re-exported, re-measure
 * rather than nudging these by eye.
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

/** Underlined blanks on the TAFSAL layout, keyed by the field written on them. */
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

/** Bordered boxes on the TAFSAL layout. */
export const BOXES = {
  registration:      { top: 105.39, bottom: 130.04, x0: 57.00, x1: 164.16 },
  computerCode:      { top: 247.82, bottom: 272.47, x0: 57.00, x1: 164.16 },
  grNumber:          { top: 383.06, bottom: 407.72, x0: 57.00, x1: 164.16 },
  slcNumber:         { top: 534.26, bottom: 558.92, x0: 57.00, x1: 164.16 },
  photo:             { top: 651.85, bottom: 790.69, x0: 51.44, x1: 170.51 },

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
 * Where the TAFSS blank differs from the TAFSAL layout. Everything not listed
 * here sits exactly where it does on the TAFSAL sheets.
 */
const TAFSS_RULES: typeof RULES = {
  ...RULES,
  fatherLast:     { y: 131.21, x0: 324.18, x1: 388.74 },
  lastSchool:     { y: 324.99, x0: 302.25, x1: 528.36 },
  admissionMonth: { y: 349.75, x0: 283.12, x1: 351.98 },
  section:        { y: 432.89, x0: 417.75, x1: 528.36 },
  promotedLevel:  { y: 573.53, x0: 331.50, x1: 359.81 },
  resitSubjects:  { y: 598.00, x0: 444.33, x1: 528.36 },
  remarks:        { y: 694.86, x0: 235.84, x1: 526.11 },
  preparedBy:     { y: 719.11, x0: 259.17, x1: 310.91 },
  recheckedBy:    { y: 719.11, x0: 383.25, x1: 430.87 },
  postedBy:       { y: 719.11, x0: 483.00, x1: 528.36 },
  leadTeacher:    { y: 743.21, x0: 269.20, x1: 345.23 },
  directress:     { y: 743.07, x0: 462.75, x1: 528.36 },
  day:            { y: 767.34, x0: 218.81, x1: 315.97 },
  date:           { y: 767.34, x0: 349.81, x1: 528.32 },
};

const TAFSS_BOXES: typeof BOXES = {
  ...BOXES,
  presentYearFrom: { top: 447.12, bottom: 459.26, x0: 284.97, x1: 306.57 },
  presentYearTo:   { top: 447.12, bottom: 459.26, x0: 317.47, x1: 339.07 },
};

export type SlcTemplateId =
  | 'tafsal-jauhar'
  | 'tafsal-kaneez-fatima'
  | 'tafsal-north-nazimabad'
  | 'tafss-jauhar';

export interface SlcTemplate {
  id: SlcTemplateId;
  /** File name inside `slc-formats/`. */
  file: string;
  /** The segment the blank is printed for — its title and COMPUTER CODE prefix. */
  prefix: 'TAFSAL' | 'TAFSS';
  /**
   * Right edge of the prefix pre-printed in the COMPUTER CODE box. The blank
   * prints only "TAFSAL" / "TAFSS"; the dash and the code are written after it.
   */
  codePrefixEnd: number;
  rules: typeof RULES;
  boxes: typeof BOXES;
}

export const SLC_TEMPLATES: Record<SlcTemplateId, SlcTemplate> = {
  'tafsal-jauhar': {
    id: 'tafsal-jauhar',
    file: 'slc-tafsal-jauhar.pdf',
    prefix: 'TAFSAL',
    codePrefixEnd: 106.16,
    rules: RULES,
    boxes: BOXES,
  },
  'tafsal-kaneez-fatima': {
    id: 'tafsal-kaneez-fatima',
    file: 'slc-tafsal-kaneez-fatima.pdf',
    prefix: 'TAFSAL',
    codePrefixEnd: 106.16,
    rules: RULES,
    boxes: BOXES,
  },
  'tafsal-north-nazimabad': {
    id: 'tafsal-north-nazimabad',
    file: 'slc-tafsal-north-nazimabad.pdf',
    prefix: 'TAFSAL',
    codePrefixEnd: 106.16,
    rules: RULES,
    boxes: BOXES,
  },
  'tafss-jauhar': {
    id: 'tafss-jauhar',
    file: 'slc-tafss-jauhar.pdf',
    prefix: 'TAFSS',
    codePrefixEnd: 96.8,
    rules: TAFSS_RULES,
    boxes: TAFSS_BOXES,
  },
};

/** `campuses.id` — KNF and NNZ. Gulistan-e-Jauhar (GEJ, id 1) is the default. */
const KANEEZ_FATIMA_CAMPUS_ID = 2;
const NORTH_NAZIMABAD_CAMPUS_ID = 3;
/** `classes.id` 15–19 — VI, VII, VIII, IX, X (Secondary). */
const TAFSS_CLASS_IDS = new Set([15, 16, 17, 18, 19]);

/**
 * Picks the blank a student's certificate is printed on. Campus wins over
 * class: a secondary student at Kaneez Fatima or North Nazimabad still gets
 * that campus's sheet, because the campus footer is what the blank is for.
 */
export function resolveSlcTemplate(student: {
  campus_id?: number | null;
  class_id?: number | null;
}): SlcTemplate {
  if (student.campus_id === KANEEZ_FATIMA_CAMPUS_ID) return SLC_TEMPLATES['tafsal-kaneez-fatima'];
  if (student.campus_id === NORTH_NAZIMABAD_CAMPUS_ID) return SLC_TEMPLATES['tafsal-north-nazimabad'];
  if (student.class_id != null && TAFSS_CLASS_IDS.has(student.class_id)) {
    return SLC_TEMPLATES['tafss-jauhar'];
  }
  return SLC_TEMPLATES['tafsal-jauhar'];
}

export interface SlcNameParts {
  last?: string | null;
  first?: string | null;
  middle?: string | null;
}

export interface SlcDateParts {
  month?: string | null;
  day?: string | null;
  year?: string | null;
}

export interface SlcYearParts {
  from?: string | null;
  to?: string | null;
}

/** Exactly the payload `getLeavingCertificateData` returns, plus the two
 *  fields only the operator can supply. */
export interface SlcCertificateData {
  registration_number?: string | null;
  cc?: number | string | null;
  gr_number?: string | null;
  slc_number?: string | null;
  name?: SlcNameParts;
  father_name?: SlcNameParts;
  dob?: SlcDateParts;
  place_of_birth?: { country?: string | null; province?: string | null; city?: string | null };
  nationality?: string | null;
  gender?: string | null;
  religion?: string | null;
  identification_marks?: string | null;
  last_school_attended?: string | null;
  date_of_admission?: SlcDateParts;
  scholastic_year_admitted?: SlcYearParts;
  class_admitted?: string | null;
  present_level?: string | null;
  section?: string | null;
  scholastic_year_present?: SlcYearParts;
  last_date_of_attendance?: SlcDateParts;
  reason_for_leaving?: string | null;
  result_scholastic_year?: SlcYearParts;
  passed_promoted_level?: string | null;
  passed_promoted_year?: SlcYearParts;
  resit_subjects?: string | null;
  detained_level?: string | null;
  detained_year?: SlcYearParts;
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

const resolveTemplatePath = (file: string): string => {
  // process.cwd() is the repo root under `nest start` and on the deployed box
  // alike; the __dirname hop is the fallback for a build run from elsewhere.
  const candidates = [
    join(process.cwd(), 'slc-formats', file),
    join(__dirname, '..', '..', '..', 'slc-formats', file),
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
    `Leaving-certificate template ${file} not found. Looked in: ${candidates.join(', ')}`,
  );
};

export async function fillLeavingCertificate(
  data: SlcCertificateData,
  template: SlcTemplate,
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(readFileSync(resolveTemplatePath(template.file)));
  const page = pdfDoc.getPage(0);
  // Times-Bold, the same serif family as the blank's own labels, so the filled
  // values read as part of the certificate rather than stamped on top of it.
  const font = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
  const { rules: RULE, boxes: BOX } = template;

  const ink = rgb(0, 0, 0);

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

  /**
   * Writes a value centred on its underlined blank. The captions under the
   * rules (LAST / FIRST / MIDDLE, MONTH / DAY / YEAR, COUNTRY …) are centred, and
   * a short value like "JR-I" left-aligned on a long rule reads as sitting off to
   * one side, so every rule is filled centred. `RULE_INDENT` on both ends still
   * keeps a value that fills the whole rule clear of its label.
   */
  const onRule = (rule: Rule, value: unknown, size = DEFAULT_SIZE) => {
    const text = clean(value);
    if (!text) return;
    const width = rule.x1 - rule.x0;
    const fontSize = fit(text, width - 2 * RULE_INDENT, size);
    const textWidth = font.widthOfTextAtSize(text, fontSize);
    page.drawText(text, {
      x: rule.x0 + (width - textWidth) / 2,
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
  inBox(BOX.registration, data.registration_number, 11);
  inBox(BOX.grNumber, data.gr_number, 11);
  inBox(BOX.slcNumber, data.slc_number, 11);
  // The blank prints only the segment prefix ("TAFSAL" / "TAFSS") in this box;
  // the separating dash and the code itself are written after it.
  const computerCode = clean(data.cc);
  if (computerCode) {
    // The printed prefix's baseline (its text box bottom, less the descender).
    const baseline = PAGE_HEIGHT - 264.7;
    const dashX = template.codePrefixEnd + 5;
    page.drawText('-', { x: dashX, y: baseline, size: 11, font, color: ink });
    const codeX = dashX + font.widthOfTextAtSize('-', 11) + 5;
    const codeSize = fit(computerCode, BOX.computerCode.x1 - codeX - 4, 11);
    page.drawText(computerCode, {
      x: codeX,
      y: baseline,
      size: codeSize,
      font,
      color: ink,
    });
  }

  // ── Identity ─────────────────────────────────────────────────────────────
  onRule(RULE.nameLast, data.name?.last);
  onRule(RULE.nameFirst, data.name?.first);
  onRule(RULE.nameMiddle, data.name?.middle);

  onRule(RULE.fatherLast, data.father_name?.last);
  onRule(RULE.fatherFirst, data.father_name?.first);
  onRule(RULE.fatherMiddle, data.father_name?.middle);

  onRule(RULE.dobMonth, data.dob?.month);
  onRule(RULE.dobDay, data.dob?.day);
  onRule(RULE.dobYear, data.dob?.year);

  onRule(RULE.pobCountry, data.place_of_birth?.country);
  onRule(RULE.pobProvince, data.place_of_birth?.province);
  onRule(RULE.pobCity, data.place_of_birth?.city);

  onRule(RULE.nationality, data.nationality);

  // ── Sex / religion ───────────────────────────────────────────────────────
  // The blanks ship with every box empty, so exactly one tick is drawn per row.
  const gender = clean(data.gender).toUpperCase();
  tick(gender.startsWith('F') ? BOX.sexFemale : BOX.sexMale);

  const religion = clean(data.religion).toUpperCase();
  if (religion.startsWith('CHRIST')) {
    tick(BOX.religionChristian);
  } else if (!religion || religion.startsWith('MUSLIM') || religion.startsWith('ISLAM')) {
    tick(BOX.religionMuslim);
  } else {
    // Anything else belongs on the OTHERS blank, with neither box ticked.
    onRule(RULE.religionOthers, religion);
  }

  onRule(RULE.identification, data.identification_marks);
  onRule(RULE.lastSchool, data.last_school_attended);

  // ── Admission ────────────────────────────────────────────────────────────
  onRule(RULE.admissionMonth, data.date_of_admission?.month);
  onRule(RULE.admissionDay, data.date_of_admission?.day);
  onRule(RULE.admissionYear, data.date_of_admission?.year);

  inBox(BOX.admittedYearFrom, data.scholastic_year_admitted?.from, 7);
  inBox(BOX.admittedYearTo, data.scholastic_year_admitted?.to, 7);
  inBox(BOX.levelAdmitted, data.class_admitted, 7);

  onRule(RULE.presentLevel, data.present_level);
  onRule(RULE.section, data.section);
  inBox(BOX.presentYearFrom, data.scholastic_year_present?.from, 7);
  inBox(BOX.presentYearTo, data.scholastic_year_present?.to, 7);

  // ── Leaving ──────────────────────────────────────────────────────────────
  onRule(RULE.attendanceMonth, data.last_date_of_attendance?.month);
  onRule(RULE.attendanceDay, data.last_date_of_attendance?.day);
  onRule(RULE.attendanceYear, data.last_date_of_attendance?.year);

  onRule(RULE.reasonLeaving, data.reason_for_leaving);

  inBox(BOX.resultYearFrom, data.result_scholastic_year?.from, 7);
  inBox(BOX.resultYearTo, data.result_scholastic_year?.to, 7);

  onRule(RULE.promotedLevel, data.passed_promoted_level, 7);
  inBox(BOX.promotedYearFrom, data.passed_promoted_year?.from, 7);
  inBox(BOX.promotedYearTo, data.passed_promoted_year?.to, 7);

  // The form gives resit subjects a short tail after its label and a full-width
  // second line; a long list uses the wide line rather than being squeezed.
  const resit = clean(data.resit_subjects);
  if (resit) {
    if (font.widthOfTextAtSize(resit, DEFAULT_SIZE) <= RULE.resitSubjects.x1 - RULE.resitSubjects.x0) {
      onRule(RULE.resitSubjects, resit);
    } else {
      onRule(RULE.resitOverflow, resit);
    }
  }

  onRule(RULE.detainedLevel, data.detained_level, 7);
  inBox(BOX.detainedYearFrom, data.detained_year?.from, 7);
  inBox(BOX.detainedYearTo, data.detained_year?.to, 7);

  // ── Footer ───────────────────────────────────────────────────────────────
  onRule(RULE.dues, data.school_dues);
  onRule(RULE.remarks, data.remarks);
  onRule(RULE.preparedBy, data.prepared_by, 7);
  onRule(RULE.recheckedBy, data.rechecked_by, 7);
  onRule(RULE.postedBy, data.posted_by, 7);
  onRule(RULE.leadTeacher, data.class_teacher, 7);
  onRule(RULE.directress, data.programme_directress, 7);
  onRule(RULE.day, data.day);
  onRule(RULE.date, data.date);

  await drawPhotograph(pdfDoc, page, BOX.photo, data.photograph_base64);

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
  box: Box,
  base64: string | null | undefined,
): Promise<void> {
  if (!base64) return;
  try {
    const isPng = base64.includes('image/png') || base64.startsWith('iVBOR');
    const payload = base64.includes(',') ? base64.split(',')[1] : base64;
    const bytes = Buffer.from(payload, 'base64');
    const image = isPng ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);

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
