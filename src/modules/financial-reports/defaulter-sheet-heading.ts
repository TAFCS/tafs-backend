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
