export function calculateOffset(page: number, limit: number): number {
  const safePage = Number.isFinite(page) && page > 0 ? page : 1;
  const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 10;

  return (safePage - 1) * safeLimit;
}

