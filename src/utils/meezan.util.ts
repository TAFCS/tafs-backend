export function toMeezanVoucherNumber(voucherId: number, issueDate: Date): string {
  const mm = String(issueDate.getMonth() + 1).padStart(2, '0');
  const yyyy = String(issueDate.getFullYear());
  const seq = String(voucherId).padStart(5, '0');
  return `${mm}${yyyy}${seq}`;
}

export function fromMeezanVoucherNumber(meezanNum: string): number {
  // strip first 6 chars (MMYYYY), parse remainder as int
  return parseInt(meezanNum.slice(6), 10);
}
