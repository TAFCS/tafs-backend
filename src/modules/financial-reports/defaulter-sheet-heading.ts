/**
 * The title block of the school-format defaulters sheet (TAFSD-289): which
 * school name heads it, the classes line when it mixes both schools, the
 * campus line and the session line.
 */

/** `classes.id` 15–19 — VI, VII, VIII, IX, X: The American Foundation School for Secondary Studies. */
const SECONDARY_CLASS_IDS = new Set([15, 16, 17, 18, 19]);
/** Secondary runs Apr–Mar; every other class runs Aug–Jul. */
const SECONDARY_TERM_START_MONTH = 4;
const DEFAULT_TERM_START_MONTH = 8;

export const DEFAULTER_SHEET_LIST_TITLE = "AT A GLANCE CONSOLIDATED DEFAULTERS' LIST";

const SCHOOL = 'THE AMERICAN FOUNDATION SCHOOL';
const SCHOOL_SECONDARY = `${SCHOOL} FOR SECONDARY STUDIES`;
const SCHOOL_A_LEVEL = `${SCHOOL} FOR A LEVEL STUDIES`;

export interface DefaulterSheetClass {
  class_id: number | null;
  class_name: string;
}

export interface DefaulterSheetHeading {
  school: string;
  /** "CLASSES: VIII, AS LEVEL" — only when the sheet mixes both schools. */
  classesLine: string | null;
  session: string;
}

/**
 * @param rows        the students on this sheet
 * @param classFiltered whether the export was narrowed by class or segment;
 *                    without that it is the whole school and gets the plain name
 * @param asOfDate    YYYY-MM-DD, the report's as-of date
 */
export function defaulterSheetHeading(
  rows: DefaulterSheetClass[],
  classFiltered: boolean,
  asOfDate: string,
): DefaulterSheetHeading {
  const classes = new Map<number, string>();
  for (const r of rows) {
    if (r.class_id == null) continue;
    if (!classes.has(r.class_id)) classes.set(r.class_id, r.class_name.trim().toUpperCase());
  }
  const ids = [...classes.keys()];
  const secondary = ids.filter((id) => SECONDARY_CLASS_IDS.has(id)).length;
  const allSecondary = ids.length > 0 && secondary === ids.length;
  const noSecondary = ids.length > 0 && secondary === 0;

  let school = SCHOOL;
  let classesLine: string | null = null;
  if (classFiltered) {
    if (allSecondary) school = SCHOOL_SECONDARY;
    else if (noSecondary) school = SCHOOL_A_LEVEL;
    else if (ids.length > 0) {
      classesLine = `CLASSES: ${ids
        .sort((a, b) => a - b)
        .map((id) => classes.get(id) || String(id))
        .join(', ')}`;
    }
  }

  return {
    school,
    classesLine,
    session: sessionLine(asOfDate, allSecondary ? SECONDARY_TERM_START_MONTH : DEFAULT_TERM_START_MONTH),
  };
}

/** "SESSION 2026–2027": the academic year as_of falls in, for a term starting in `termStartMonth`. */
export function sessionLine(asOfDate: string, termStartMonth = DEFAULT_TERM_START_MONTH): string {
  const [y, m] = asOfDate.split('-').map(Number);
  const start = m >= termStartMonth ? y : y - 1;
  return `SESSION ${start}–${start + 1}`;
}

/** "GULISTAN-E-JAUHAR CAMPUS" — the campus's full name on its own line. */
export function campusLine(campusName: string): string {
  const name = campusName.trim().toUpperCase();
  if (!name) return '';
  return /\bCAMPUS$/.test(name) ? name : `${name} CAMPUS`;
}

/** Names for the ids a defaulters export was filtered by, looked up once per export. */
export interface DefaulterFilterNames {
  campuses: Map<number, string>;
  classes: Map<number, string>;
  sections: Map<number, string>;
  segments: Map<number, string>;
}

export interface DefaulterFilterQuery {
  campus_id?: number[];
  class_id?: number[];
  section_id?: number[];
  segment_id?: number[];
  student_status?: string[];
  severity?: string[];
  is_fee_endowment?: boolean;
  is_complementary?: boolean;
  graduated_from_class_id?: number[];
  graduated_year_range?: string;
  cc?: number;
}

const STATUS_WORDS: Record<string, string> = {
  ENROLLED: 'ENROLLED',
  LEFT: 'LEFT',
  EXPELLED: 'EXPELLED',
  GRADUATED: 'GRADUATED',
  SOFT_ADMISSION: 'SOFT ADMISSION',
  QUICK_ADMISSION: 'QUICK ADMISSION',
};

/**
 * TAFSD-291: one plain-words line per filter applied on the page, for the top
 * of the sheet — names, never ids; filters that weren't applied are left out.
 *
 * @param monthsLine   the months-behind / arrear-month line ("4 & 5 MONTHS
 *                     DEFAULTERS"), or null when neither was filtered
 * @param omitClasses  the title block already names the classes (mixed sheet)
 * @returns `['ALL STUDENTS']` when nothing at all was filtered; may be empty
 *          when the only filter is the classes the title block names
 */
export function defaulterFilterLines(
  query: DefaulterFilterQuery,
  names: DefaulterFilterNames,
  monthsLine: string | null,
  omitClasses = false,
  /** The page's default status filter, which is not called out. Defaulters: enrolled; the other reports: all. */
  defaultStatuses: readonly string[] = ['ENROLLED'],
  /** Report-specific filters already in words ("FEE STATUS: PAID"), placed after the shared ones. */
  extraLines: readonly string[] = [],
): string[] {
  const named = (ids: number[] | undefined, map: Map<number, string>) =>
    (ids ?? []).map((id) => (map.get(id) ?? `#${id}`).trim().toUpperCase()).join(', ');
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
  const lines: string[] = [];

  if (monthsLine) lines.push(monthsLine);
  if (query.campus_id?.length)
    lines.push(`${plural(query.campus_id.length, 'CAMPUS', 'CAMPUSES')}: ${named(query.campus_id, names.campuses)}`);
  if (query.class_id?.length && !omitClasses)
    lines.push(`${plural(query.class_id.length, 'CLASS', 'CLASSES')}: ${named(query.class_id, names.classes)}`);
  if (query.segment_id?.length)
    lines.push(`${plural(query.segment_id.length, 'SEGMENT', 'SEGMENTS')}: ${named(query.segment_id, names.segments)}`);
  if (query.section_id?.length)
    lines.push(`${plural(query.section_id.length, 'SECTION', 'SECTIONS')}: ${named(query.section_id, names.sections)}`);
  // The page's default status filter is not called out (enrolled-only on the
  // defaulters page). Where that default is narrower than "all", a cleared
  // filter widens the list to every status — say so, or a sheet full of left
  // students would read like the ordinary list.
  const statuses = query.student_status ?? [];
  const isDefault =
    statuses.length === defaultStatuses.length && statuses.every((s) => defaultStatuses.includes(s));
  if (statuses.length === 0 && !isDefault) lines.push('ALL STUDENT STATUSES');
  else if (statuses.length && !isDefault) {
    const words = statuses.map((s) => STATUS_WORDS[s] ?? s.replace(/_/g, ' '));
    lines.push(`${words.join(' & ')} STUDENTS ONLY`);
  }
  if (query.severity?.length)
    lines.push(`SEVERITY: ${query.severity.map((s) => (s === 'EXPIRING' ? 'EXPIRED BILL' : s)).join(', ')}`);
  if (query.is_fee_endowment != null)
    lines.push(query.is_fee_endowment ? 'FEE ENDOWMENT STUDENTS ONLY' : 'EXCLUDING FEE ENDOWMENT STUDENTS');
  if (query.is_complementary != null)
    lines.push(query.is_complementary ? 'COMPLEMENTARY STUDENTS ONLY' : 'EXCLUDING COMPLEMENTARY STUDENTS');
  if (query.graduated_from_class_id?.length)
    lines.push(`GRADUATED FROM: ${named(query.graduated_from_class_id, names.classes)}`);
  if (query.graduated_year_range) lines.push(`GRADUATED ${query.graduated_year_range.replace('-', '–')}`);
  if (query.cc != null) lines.push(`C.C. ${query.cc}`);
  lines.push(...extraLines);

  // A class filter the title block already names is still a filter: no line,
  // but not "ALL STUDENTS" either.
  if (lines.length === 0 && !(omitClasses && query.class_id?.length)) return ['ALL STUDENTS'];
  return lines;
}
