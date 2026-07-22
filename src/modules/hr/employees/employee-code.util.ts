export interface EmployeeCodeParts {
  dep: string;
  number: string;
  campusPrefix?: string | null;
}

/** GEJ-02-1955 or plain 02-1955 */
const PREFIXED_CODE_RE = /^([A-Z]{2,4})-(\d{2})-(.+)$/;
const SPLIT_CODE_RE = /^(\d{2})-(.+)$/;

const CAMPUS_PREFIX_BY_ID: Record<number, string> = {
  1: 'GEJ',
  2: 'GKF',
  3: 'NNN',
};

export function campusPrefixForId(campusId: number | null | undefined): string | null {
  if (campusId == null) return null;
  return CAMPUS_PREFIX_BY_ID[campusId] ?? null;
}

/** Parse codes like GEJ-02-1955 or 02-1955. Returns null for legacy formats (EMP-*, etc.). */
export function parseEmployeeCode(code: string | null | undefined): EmployeeCodeParts | null {
  if (!code) return null;
  const raw = code.trim().toUpperCase();
  const prefixed = raw.match(PREFIXED_CODE_RE);
  if (prefixed) {
    return { campusPrefix: prefixed[1], dep: prefixed[2], number: prefixed[3] };
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
  const prefix = campusPrefix?.trim().toUpperCase();
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
  const campusPrefix = input.campusPrefix?.trim().toUpperCase() || null;

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
