import { ScopeDimension } from '@prisma/client';
import { findDimensionsToCollapse, UserScopeEntryLike } from '../../../scripts/collapse-fully-ticked-scopes';

describe('collapse-fully-ticked-scopes', () => {
  const allOptionIds: Record<ScopeDimension, Set<number>> = {
    [ScopeDimension.CAMPUS]: new Set([1, 2, 3]),
    [ScopeDimension.SEGMENT]: new Set([1, 2, 3, 4, 5, 6]),
    [ScopeDimension.CLASS]: new Set([10, 20]),
    [ScopeDimension.SECTION]: new Set([1, 2]),
    [ScopeDimension.DEPARTMENT]: new Set([100, 200]),
    [ScopeDimension.STAFF_CATEGORY]: new Set([5, 6]),
  };

  it('returns empty when user has partial selections', () => {
    const entries: UserScopeEntryLike[] = [
      { dimension: ScopeDimension.CAMPUS, ref_id: 1 },
      { dimension: ScopeDimension.SEGMENT, ref_id: 1 },
      { dimension: ScopeDimension.SEGMENT, ref_id: 2 },
    ];
    const result = findDimensionsToCollapse(allOptionIds, entries);
    expect(result).toEqual([]);
  });

  it('identifies dimension when user covers all options', () => {
    const entries: UserScopeEntryLike[] = [
      // All campuses
      { dimension: ScopeDimension.CAMPUS, ref_id: 1 },
      { dimension: ScopeDimension.CAMPUS, ref_id: 2 },
      { dimension: ScopeDimension.CAMPUS, ref_id: 3 },
      // Partial segment
      { dimension: ScopeDimension.SEGMENT, ref_id: 1 },
    ];
    const result = findDimensionsToCollapse(allOptionIds, entries);
    expect(result).toEqual([{ dimension: ScopeDimension.CAMPUS, count: 3 }]);
  });

  it('identifies multiple fully-ticked dimensions for a user', () => {
    const entries: UserScopeEntryLike[] = [
      // All 6 segments
      { dimension: ScopeDimension.SEGMENT, ref_id: 1 },
      { dimension: ScopeDimension.SEGMENT, ref_id: 2 },
      { dimension: ScopeDimension.SEGMENT, ref_id: 3 },
      { dimension: ScopeDimension.SEGMENT, ref_id: 4 },
      { dimension: ScopeDimension.SEGMENT, ref_id: 5 },
      { dimension: ScopeDimension.SEGMENT, ref_id: 6 },
      // All departments
      { dimension: ScopeDimension.DEPARTMENT, ref_id: 100 },
      { dimension: ScopeDimension.DEPARTMENT, ref_id: 200 },
      // Only 1 campus
      { dimension: ScopeDimension.CAMPUS, ref_id: 1 },
    ];
    const result = findDimensionsToCollapse(allOptionIds, entries);
    expect(result).toEqual([
      { dimension: ScopeDimension.SEGMENT, count: 6 },
      { dimension: ScopeDimension.DEPARTMENT, count: 2 },
    ]);
  });

  it('ignores empty user scope entries or unselected dimensions', () => {
    const result = findDimensionsToCollapse(allOptionIds, []);
    expect(result).toEqual([]);
  });
});
