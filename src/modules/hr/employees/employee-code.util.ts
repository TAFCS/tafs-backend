export interface EmployeeCodeParts {
  dep: string;
  number: string;
  campusPrefix?: string | null;
}

/** GEJ-02-1955 or plain 02-1955 */
const PREFIXED_CODE_RE = /^([A-Z]{2,4})-(\d{2})-(.+)$/;
/** Mis-saved codes that used student G.R. prefix (KF-A / A-N) before campus fields were split. */
const STUDENT_PREFIX_MISTAKE_RE = /^(KF-A|A-N)-(\d{2})-(.+)$/i;
const SPLIT_CODE_RE = /^(\d{2})-(.+)$/;

const CAMPUS_PREFIX_BY_ID: Record<number, string> = {
  1: 'GEJ',
  2: 'GKF',
  3: 'NNN',
};

/** Student G.R. prefixes — must never be used for employee_code (even if stored on campuses.campus_prefix). */
const STUDENT_GR_CAMPUS_PREFIXES = new Set(['KF-A', 'A-N', 'A-']);

export function isStudentGrCampusPrefix(prefix: string | null | undefined): boolean {
  if (!prefix?.trim()) return false;
  const compact = prefix.trim().toUpperCase().replace(/\s/g, '');
  if (STUDENT_GR_CAMPUS_PREFIXES.has(compact)) return true;
  if (compact.startsWith('KF-A')) return true;
  return false;
}

/**
 * HR employee campus prefix: campuses.campus_prefix when it is an HR code (GEJ, GKF, …),
 * otherwise the canonical map by campus id. Ignores student G.R. values on campus_prefix.
 */
export function resolveEmployeeCampusPrefix(
  campusId: number | null | undefined,
  campusPrefixFromDb?: string | null,
): string | null {
  const fromDb = normalizeCampusPrefix(campusPrefixFromDb);
  if (fromDb && !isStudentGrCampusPrefix(fromDb)) {
    return fromDb;
  }
  return campusPrefixForId(campusId);
}

export function normalizeCampusPrefix(prefix: string | null | undefined): string | null {
  if (!prefix) return null;
  return prefix.trim().toUpperCase();
}

export function campusPrefixForId(campusId: number | null | undefined): string | null {
  if (campusId == null) return null;
  return CAMPUS_PREFIX_BY_ID[campusId] ?? null;
}

/** Parse codes like GEJ-02-1955 or 02-1955. Returns null for legacy formats (EMP-*, etc.). */
export function parseEmployeeCode(code: string | null | undefined): EmployeeCodeParts | null {
  if (!code) return null;
  const raw = code.trim().toUpperCase();
  const studentMistake = raw.match(STUDENT_PREFIX_MISTAKE_RE);
  if (studentMistake) {
    return { dep: studentMistake[2], number: studentMistake[3], campusPrefix: null };
  }
  const prefixed = raw.match(PREFIXED_CODE_RE);
  if (prefixed) {
    const p = normalizeCampusPrefix(prefixed[1]);
    if (p && isStudentGrCampusPrefix(p)) {
      return { dep: prefixed[2], number: prefixed[3], campusPrefix: null };
    }
    return { campusPrefix: p, dep: prefixed[2], number: prefixed[3] };
  }
  const match = raw.match(SPLIT_CODE_RE);
  if (!match) return null;
  return { dep: match[1], number: match[2], campusPrefix: null };
}

/** Build canonical employee_code from dep + number (+ optional campus prefix). */
export function composeEmployeeCode(
  dep: string,
  number: string,
  campusPrefix?: string | null,
): string {
  const normalizedDep = dep.trim().padStart(2, '0');
  const normalizedNumber = number.trim();
  const body = `${normalizedDep}-${normalizedNumber}`;
  const prefix = normalizeCampusPrefix(campusPrefix);
  return prefix ? `${prefix}-${body}` : body;
}

export interface ResolvedEmployeeCode {
  employee_code: string | null;
  employee_code_dep: string | null;
  employee_code_number: string | null;
}

/**
 * Resolve stored code fields from API input.
 * Prefers explicit dep+number; falls back to parsing employee_code; supports legacy free-form codes.
 * When campusPrefix is provided (or parsed), it is included in employee_code.
 */
export function resolveEmployeeCodeFields(input: {
  employee_code?: string | null;
  employee_code_dep?: string | null;
  employee_code_number?: string | null;
  campusPrefix?: string | null;
}): ResolvedEmployeeCode {
  const dep = input.employee_code_dep?.trim() ?? '';
  const number = input.employee_code_number?.trim() ?? '';
  const campusPrefix = normalizeCampusPrefix(input.campusPrefix);

  if (dep && number) {
    return {
      employee_code: composeEmployeeCode(dep, number, campusPrefix),
      employee_code_dep: dep.padStart(2, '0'),
      employee_code_number: number,
    };
  }

  const rawCode = input.employee_code?.trim();
  if (!rawCode) {
    return { employee_code: null, employee_code_dep: null, employee_code_number: null };
  }

  const parsed = parseEmployeeCode(rawCode);
  if (parsed) {
    const prefix = campusPrefix ?? parsed.campusPrefix ?? null;
    return {
      employee_code: composeEmployeeCode(parsed.dep, parsed.number, prefix),
      employee_code_dep: parsed.dep,
      employee_code_number: parsed.number,
    };
  }

  return {
    employee_code: rawCode.toUpperCase(),
    employee_code_dep: null,
    employee_code_number: null,
  };
}
