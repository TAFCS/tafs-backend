export function toMeezanVoucherNumber(voucherId: number, issueDate: Date): string {
  const mm = String(issueDate.getMonth() + 1).padStart(2, '0');
  const yy = String(issueDate.getFullYear()).slice(2);
  const seq = String(voucherId).padStart(7, '0');
  return `${mm}${yy}${seq}`;
}

export function fromMeezanVoucherNumber(meezanNum: string): number {
  // strip first 4 chars (MMYY), parse remainder as int
  return parseInt(meezanNum.slice(4), 10);
}
