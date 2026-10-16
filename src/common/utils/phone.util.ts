/**
 * Pakistani phone numbers are stored every which way ("3122244523",
 * "03122244523", "+923122244523", "0312-2244523"). These reduce them to one
 * form so they can be shown consistently and compared.
 */

/**
 * Digits in local form: "03122244523". Other numbers keep their digits;
 * placeholders with too few digits to be a phone ("N/A", "021-N/A") give "".
 */
export function normalizePkPhone(raw: string | null | undefined): string {
  let digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length < 7) return '';
  if (digits.startsWith('0092')) digits = digits.slice(4);
  else if (digits.startsWith('92') && digits.length === 12) digits = digits.slice(2);
  // A mobile number saved without its leading zero.
  if (digits.length === 10 && digits.startsWith('3')) digits = `0${digits}`;
  return digits;
}

/** "0312-2244523" for an 11-digit local number, otherwise the normalized digits; "" when empty. */
export function formatPkPhone(raw: string | null | undefined): string {
  const digits = normalizePkPhone(raw);
  return digits.length === 11 && digits.startsWith('0') ? `${digits.slice(0, 4)}-${digits.slice(4)}` : digits;
}
