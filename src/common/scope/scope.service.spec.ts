import { StaffRole } from '@prisma/client';
import { ScopeService } from './scope.service';
import { EMPTY_SCOPE, NO_MATCH_ID, whereForEmployees, type UserScope } from './scope.types';

const service = new ScopeService({} as any);

const staff = (scope: Partial<UserScope> = {}, role: StaffRole = StaffRole.EMPLOYEE) =>
  ({ role, scope: { ...EMPTY_SCOPE, ...scope } }) as any;

const student = (over: Partial<Record<'campus_id' | 'class_id' | 'section_id' | 'segment_id', number | null>> = {}) => ({
  campus_id: 1,
  class_id: 10,
  section_id: 100,
  segment_id: 5,
  ...over,
});

describe('ScopeService.canSeeStudent', () => {
  it('lets an unscoped user see every student', () => {
    expect(service.canSeeStudent(staff(), student())).toBe(true);
    expect(service.canSeeStudent(staff(), student({ campus_id: 99 }))).toBe(true);
  });

  it('ANDs the dimensions the user is restricted on', () => {
    const user = staff({ campuses: [1], classes: [10] });
    expect(service.canSeeStudent(user, student())).toBe(true);
    expect(service.canSeeStudent(user, student({ campus_id: 2 }))).toBe(false);
    expect(service.canSeeStudent(user, student({ class_id: 11 }))).toBe(false);
  });

  it('applies segment, which rides on the student class', () => {
    const user = staff({ segments: [5] });
    expect(service.canSeeStudent(user, student())).toBe(true);
    expect(service.canSeeStudent(user, student({ segment_id: 6 }))).toBe(false);
  });

  it('excludes a null id once that dimension is restricted', () => {
    expect(service.canSeeStudent(staff({ sections: [100] }), student({ section_id: null }))).toBe(false);
    // ...but an unrestricted dimension does not care that the column is null
    expect(service.canSeeStudent(staff({ campuses: [1] }), student({ section_id: null }))).toBe(true);
  });

  it('never scopes SUPER_ADMIN', () => {
    const god = staff({ campuses: [1] }, StaffRole.SUPER_ADMIN);
    expect(service.canSeeStudent(god, student({ campus_id: 99 }))).toBe(true);
  });

  it('throws through assertStudent where canSeeStudent returns false', () => {
    expect(() => service.assertStudent(staff({ campuses: [1] }), student({ campus_id: 2 }))).toThrow(
      /campus scope/i,
    );
  });
});

describe('ScopeService.withCategoryDepartments', () => {
  const ACADEMICS = 6;
  const ADMINISTRATION = 10;
  const TEACHER = 1; // Academics
  const IT_STAFF = 9; // Administration
  const parents: Record<number, number> = { [TEACHER]: ACADEMICS, [IT_STAFF]: ADMINISTRATION };
  const svc = new ScopeService({
    staff_categories: {
      findMany: jest.fn(async ({ where }: { where: { id: { in: number[] } } }) =>
        where.id.in.map((id) => ({ department_id: parents[id] })),
      ),
    },
  } as any);
  const scope = (s: Partial<UserScope>): UserScope => ({ ...EMPTY_SCOPE, ...s });

  it('leaves a scope with no category restriction alone', async () => {
    const s = scope({ departments: [ACADEMICS] });
    await expect(svc.withCategoryDepartments(s)).resolves.toBe(s);
  });

  it("narrows Departments = All to the categories' departments", async () => {
    const out = await svc.withCategoryDepartments(scope({ staffCategories: [TEACHER] }));
    expect(out.departments).toEqual([ACADEMICS]);
    expect(whereForEmployees(out)).toEqual({ department_id: { in: [ACADEMICS] }, staff_category_id: { in: [TEACHER] } });
  });

  it('intersects an explicit department scope', async () => {
    const out = await svc.withCategoryDepartments(
      scope({ departments: [ACADEMICS, ADMINISTRATION], staffCategories: [TEACHER] }),
    );
    expect(out.departments).toEqual([ACADEMICS]);
  });

  it('restricts to nothing, never to everything, when they do not overlap', async () => {
    const out = await svc.withCategoryDepartments(scope({ departments: [ACADEMICS], staffCategories: [IT_STAFF] }));
    expect(out.departments).toEqual([NO_MATCH_ID]);
  });

  it('hides a category-matched employee whose department disagrees', async () => {
    const user = staff(await svc.withCategoryDepartments(scope({ staffCategories: [TEACHER] })));
    expect(svc.canSeeEmployee(user, { department_id: ACADEMICS, staff_category_id: TEACHER })).toBe(true);
    expect(svc.canSeeEmployee(user, { department_id: ADMINISTRATION, staff_category_id: TEACHER })).toBe(false);
  });
});
