import {
  EMPTY_SCOPE,
  isFullyUnrestricted,
  scopeAllows,
  scopeFromEntries,
  whereForEmployees,
  whereForStudents,
  type UserScope,
} from './scope.types';

const scope = (over: Partial<UserScope> = {}): UserScope => ({
  ...EMPTY_SCOPE,
  campuses: [],
  segments: [],
  classes: [],
  sections: [],
  departments: [],
  staffCategories: [],
  ...over,
});

describe('scope semantics', () => {
  it('treats an empty dimension as unrestricted, not as "nothing"', () => {
    expect(scopeAllows(scope(), 'campuses', 1)).toBe(true);
    expect(scopeAllows(scope(), 'campuses', 999)).toBe(true);
    expect(isFullyUnrestricted(scope())).toBe(true);
  });

  it('restricts only the dimensions that have entries', () => {
    const s = scope({ campuses: [1, 2] });
    expect(scopeAllows(s, 'campuses', 1)).toBe(true);
    expect(scopeAllows(s, 'campuses', 3)).toBe(false);
    // segments untouched, so still unrestricted
    expect(scopeAllows(s, 'segments', 42)).toBe(true);
  });

  it('excludes null ids once a dimension is restricted', () => {
    expect(scopeAllows(scope({ campuses: [1] }), 'campuses', null)).toBe(false);
    expect(scopeAllows(scope(), 'campuses', null)).toBe(true);
  });

  it('builds a scope from persisted entries', () => {
    const s = scopeFromEntries([
      { dimension: 'CAMPUS', ref_id: 1 },
      { dimension: 'CAMPUS', ref_id: 2 },
      { dimension: 'STAFF_CATEGORY', ref_id: 5 },
    ]);
    expect(s.campuses).toEqual([1, 2]);
    expect(s.staffCategories).toEqual([5]);
    expect(s.segments).toEqual([]);
  });

  describe('whereForEmployees', () => {
    it('is an empty fragment when unrestricted, so the query is unchanged', () => {
      expect(whereForEmployees(scope())).toEqual({});
    });

    it('AND-s only the restricted dimensions', () => {
      expect(whereForEmployees(scope({ campuses: [1], departments: [3] }))).toEqual({
        campus_id: { in: [1] },
        department_id: { in: [3] },
      });
    });

    it('never scopes employees by class or section', () => {
      const fragment = whereForEmployees(scope({ classes: [7], sections: [9] }));
      expect(fragment).toEqual({});
    });
  });

  describe('whereForStudents', () => {
    it('is an empty fragment when unrestricted', () => {
      expect(whereForStudents(scope())).toEqual({});
    });

    it('applies segment through the student class relation', () => {
      expect(whereForStudents(scope({ campuses: [2], segments: [4] }))).toEqual({
        campus_id: { in: [2] },
        classes: { segment_id: { in: [4] } },
      });
    });

    it('applies class and section directly', () => {
      expect(whereForStudents(scope({ classes: [7], sections: [9] }))).toEqual({
        class_id: { in: [7] },
        section_id: { in: [9] },
      });
    });
  });
});
