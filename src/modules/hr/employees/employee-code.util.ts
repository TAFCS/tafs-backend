export interface EmployeeCodeParts {
  dep: string;
  number: string;
}

const SPLIT_CODE_RE = /^(\d{2})-(.+)$/;

/** Parse codes like 03-5256 into dep + number. Returns null for legacy formats (EMP-*, etc.). */
export function parseEmployeeCode(code: string | null | undefined): EmployeeCodeParts | null {
  if (!code) return null;
  const match = code.trim().toUpperCase().match(SPLIT_CODE_RE);
  if (!match) return null;
  return { dep: match[1], number: match[2] };
}

/** Build canonical employee_code from dep + number parts. */
export function composeEmployeeCode(dep: string, number: string): string {
  const normalizedDep = dep.trim().padStart(2, '0');
  const normalizedNumber = number.trim();
  return `${normalizedDep}-${normalizedNumber}`;
}

export interface ResolvedEmployeeCode {
  employee_code: string | null;
  employee_code_dep: string | null;
  employee_code_number: string | null;
}

/**
 * Resolve stored code fields from API input.
 * Prefers explicit dep+number; falls back to parsing employee_code; supports legacy free-form codes.
 */
export function resolveEmployeeCodeFields(input: {
  employee_code?: string | null;
  employee_code_dep?: string | null;
  employee_code_number?: string | null;
}): ResolvedEmployeeCode {
  const dep = input.employee_code_dep?.trim() ?? '';
  const number = input.employee_code_number?.trim() ?? '';

  if (dep && number) {
    return {
      employee_code: composeEmployeeCode(dep, number),
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
    return {
      employee_code: composeEmployeeCode(parsed.dep, parsed.number),
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
