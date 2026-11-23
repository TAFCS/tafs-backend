import { StaffEditingService } from './staff-editing.service';

// TAFSD-566: GET /staff-editing/students/:cc (the Student Directory edit tabs)
// returns the student's special categories. It used to leave them out of the
// query, so the form showed every student with none.

const ASSIGNMENTS = [
  {
    reason: 'Sibling of staff',
    until: new Date('2027-06-30'),
    remind_from: null,
    student_categories: { code: 'COMPLEMENTARY', label: 'Complementary', display_order: 3 },
  },
];

function build() {
  const findUnique = jest.fn(async ({ include }: any) => ({
    cc: 8141,
    full_name: 'MUHAMMAD USMAN BURAQ',
    status: 'ENROLLED',
    deleted_at: null,
    family_id: null,
    class_id: 3,
    graduated_from_class_id: null,
    campuses: null,
    classes: { id: 3, description: 'EARLY YEARS - II' },
    graduated_from_class: null,
    sections: null,
    houses: null,
    student_admissions: [],
    student_flags: [],
    student_guardians: [{ guardian_id: 1, relationship: 'FATHER', is_primary_contact: true, guardians: { full_name: 'X' } }],
    student_activities: [],
    student_languages: [],
    student_previous_schools: [],
    student_alevel_details: null,
    families: null,
    // What Prisma would return: the relation only when the query asked for it.
    ...(include?.student_category_assignments ? { student_category_assignments: ASSIGNMENTS } : {}),
  }));
  const prisma: any = new Proxy(
    { students: { findUnique } },
    { get: (t: any, k) => t[k] ?? new Proxy({}, { get: (_x, m) => jest.fn(async () => (m === 'findMany' ? [] : null)) }) },
  );
  const service = new StaffEditingService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any);
  (service as any).getStudentPhotoHistory = async () => [];
  return { service, findUnique };
}

describe('GET /staff-editing/students/:cc special categories (TAFSD-566)', () => {
  it('loads the category assignments and returns them', async () => {
    const { service, findUnique } = build();
    const s: any = await service.getStudent(8141);
    expect(findUnique.mock.calls[0][0].include.student_category_assignments).toBeTruthy();
    expect(s.categories).toEqual([
      expect.objectContaining({ key: 'COMPLEMENTARY', reason: 'Sibling of staff', until: '2027-06-30' }),
    ]);
    expect(s.is_complementary).toBe(true);
    expect(s.is_fee_endowment).toBe(false);
  });
});
