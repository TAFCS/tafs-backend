import { StaffRole } from '@prisma/client';
import {
  EMPTY_SCOPE,
  effectiveScopeOf,
  findSubordinates,
  isFullyUnrestricted,
  NO_MATCH_ID,
  scopeAllows,
  scopeFromEntries,
  whereForEmployees,
  whereForStudents,
  whereForVouchers,
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

    it('narrows by subordinate ids when reporting hierarchy is enforced', () => {
      expect(whereForEmployees(scope({ subordinates: [10, 20] }))).toEqual({
        id: { in: [10, 20] },
      });
      expect(whereForEmployees(scope({ subordinates: [NO_MATCH_ID] }))).toEqual({
        id: { in: [NO_MATCH_ID] },
      });
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

  describe('whereForVouchers', () => {
    it('is an empty fragment when unrestricted', () => {
      expect(whereForVouchers(scope())).toEqual({});
    });

    // A segment-only user (e.g. O/A Levels) used to see every voucher: the
    // hand-rolled check read campus/class/section and nothing else.
    it('applies a segment-only scope through the voucher class', () => {
      expect(whereForVouchers(scope({ segments: [3] }))).toEqual({
        classes: { segment_id: { in: [3] } },
      });
    });

    it('applies every student dimension on the voucher snapshot', () => {
      expect(whereForVouchers(scope({ campuses: [1], classes: [7], sections: [9], segments: [3] }))).toEqual({
        campus_id: { in: [1] },
        class_id: { in: [7] },
        section_id: { in: [9] },
        classes: { segment_id: { in: [3] } },
      });
    });

    it('ignores employee-only dimensions', () => {
      expect(whereForVouchers(scope({ departments: [5], staffCategories: [6] }))).toEqual({});
    });
  });
});

describe('effectiveScopeOf', () => {
  const empty = { campuses: [], segments: [], classes: [], sections: [], departments: [], staffCategories: [] };

  it('uses the scope claim, never the home campus', () => {
    expect(effectiveScopeOf({ role: StaffRole.PRINCIPAL, campusId: 1, scope: { ...empty, campuses: [2, 3] } }).campuses).toEqual([2, 3]);
    expect(effectiveScopeOf({ role: StaffRole.PRINCIPAL, campusId: 1, allowedClassIds: [4], scope: empty })).toEqual(empty);
  });

  it('reads a pre-scope session (no scope claim) from its legacy claims, so it is not widened', () => {
    expect(effectiveScopeOf({ role: StaffRole.PRINCIPAL, campusId: 1, allowedClassIds: [4, 5] })).toEqual({
      ...empty,
      campuses: [1],
      classes: [4, 5],
    });
  });

  it('never restricts SUPER_ADMIN', () => {
    expect(effectiveScopeOf({ role: StaffRole.SUPER_ADMIN, campusId: 1, scope: { ...empty, campuses: [2] } })).toEqual(empty);
  });
});

describe('findSubordinates', () => {
  it('finds direct subordinates', () => {
    const lines = [
      { employee_id: 2, manager_id: 1 },
      { employee_id: 3, manager_id: 1 },
    ];
    expect(findSubordinates(1, lines).sort()).toEqual([2, 3]);
    expect(findSubordinates(2, lines)).toEqual([]);
  });

  it('traverses multi-level descendants', () => {
    // 1 -> 2 -> 3 -> 4
    const lines = [
      { employee_id: 2, manager_id: 1 },
      { employee_id: 3, manager_id: 2 },
      { employee_id: 4, manager_id: 3 },
    ];
    expect(findSubordinates(1, lines).sort()).toEqual([2, 3, 4]);
    expect(findSubordinates(2, lines).sort()).toEqual([3, 4]);
    expect(findSubordinates(3, lines)).toEqual([4]);
    expect(findSubordinates(4, lines)).toEqual([]);
  });

  it('excludes peers and superiors', () => {
    // Manager 1 has reports 2 and 3 (peers)
    const lines = [
      { employee_id: 2, manager_id: 1 },
      { employee_id: 3, manager_id: 1 },
    ];
    // Person 2 cannot act on person 3 (peer) or person 1 (superior)
    expect(findSubordinates(2, lines)).toEqual([]);
  });

  it('safely breaks cycles and excludes caller and superiors', () => {
    // 1 -> 2 -> 1 (cycle)
    const lines = [
      { employee_id: 2, manager_id: 1 },
      { employee_id: 1, manager_id: 2 },
    ];
    expect(findSubordinates(1, lines)).toEqual([]);
    expect(findSubordinates(2, lines)).toEqual([]);
  });

  it('supports multiple managers for a single employee', () => {
    // 1 -> 3, 2 -> 3, 3 -> 4
    const lines = [
      { employee_id: 3, manager_id: 1 },
      { employee_id: 3, manager_id: 2 },
      { employee_id: 4, manager_id: 3 },
    ];
    expect(findSubordinates(1, lines).sort()).toEqual([3, 4]);
    expect(findSubordinates(2, lines).sort()).toEqual([3, 4]);
  });
});
