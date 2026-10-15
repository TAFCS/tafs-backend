import {
  descendantsOf,
  type HierarchyPerson,
  managersOutsideFit,
  managersThatLoop,
  SENIOR_LEADERSHIP_CODE,
} from './reporting-hierarchy.rules';

const ACADEMICS = 6;
const ADMIN = 10;
const GEJ = 1;
const KNF = 2;

const person = (id: number, over: Partial<HierarchyPerson> = {}): HierarchyPerson => ({
  id,
  full_name: `P${id}`,
  campus_id: GEJ,
  department_id: ACADEMICS,
  category_code: 'TEACHER',
  ...over,
});

describe('managersOutsideFit', () => {
  const teacher = person(1);

  it('accepts a manager in the same department on the same campus', () => {
    expect(managersOutsideFit(teacher, [person(2)])).toEqual([]);
  });

  it('refuses a manager from another department or campus', () => {
    const otherDept = person(2, { department_id: ADMIN });
    const otherCampus = person(3, { campus_id: KNF });
    expect(managersOutsideFit(teacher, [otherDept, otherCampus]).map((m) => m.id)).toEqual([2, 3]);
  });

  it('lets Senior Leadership manage across departments and campuses', () => {
    const directress = person(2, { department_id: ADMIN, campus_id: KNF, category_code: SENIOR_LEADERSHIP_CODE });
    expect(managersOutsideFit(teacher, [directress])).toEqual([]);
  });

  it('refuses a non-leadership manager when either record is missing campus or department', () => {
    expect(managersOutsideFit(person(1, { campus_id: null }), [person(2, { campus_id: null })])).toHaveLength(1);
    expect(managersOutsideFit(person(1, { department_id: null }), [person(2, { department_id: null })])).toHaveLength(1);
  });
});

describe('descendantsOf / managersThatLoop', () => {
  // 1 ← 2 ← 3, and 4 reports to both 2 and 5.
  const lines = [
    { employee_id: 2, manager_id: 1 },
    { employee_id: 3, manager_id: 2 },
    { employee_id: 4, manager_id: 2 },
    { employee_id: 4, manager_id: 5 },
  ];

  it('follows every line, not only primary ones', () => {
    expect([...descendantsOf(lines, 1)].sort()).toEqual([2, 3, 4]);
    expect([...descendantsOf(lines, 5)]).toEqual([4]);
  });

  it('refuses a manager who is already below the employee', () => {
    expect(managersThatLoop(lines, 1, [3])).toEqual([3]);
    expect(managersThatLoop(lines, 5, [4, 1])).toEqual([4]);
  });

  it('refuses self and allows anyone not below', () => {
    expect(managersThatLoop(lines, 3, [3])).toEqual([3]);
    expect(managersThatLoop(lines, 3, [5, 1])).toEqual([]);
  });

  it('copes with a loop already in the data without hanging', () => {
    const looped = [...lines, { employee_id: 1, manager_id: 3 }];
    expect([...descendantsOf(looped, 1)].sort()).toEqual([1, 2, 3, 4]);
  });
});
