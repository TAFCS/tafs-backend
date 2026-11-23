import { StudentsService } from './students.service';

// TAFSD-583: GET /students/:cc (Student Fees, the profile) returns the
// student's special categories. It used to leave them out of the query, so
// flattenBenefits always saw none and every category toggle showed off.

const ASSIGNMENTS = [
  {
    reason: 'Orphan',
    until: new Date('2027-07-31'),
    remind_from: new Date('2027-07-01'),
    student_categories: { code: 'FEE_ENDOWMENT', label: 'Fee Endowment', display_order: 1 },
  },
];

function build() {
  const findFirst = jest.fn(async ({ include }: any) => ({
    cc: 8141,
    full_name: 'MUHAMMAD USMAN BURAQ',
    status: 'ENROLLED',
    class_id: 3,
    section_id: 1,
    family_id: 10,
    graduated_from_class_id: null,
    campuses: { id: 1 },
    families: null,
    classes: { id: 3, description: 'EARLY YEARS - II' },
    sections: { id: 1, description: 'A' },
    student_admissions: [],
    student_guardians: [{ is_primary_contact: true, relationship: 'FATHER', guardian_id: 1, guardians: { full_name: 'X' } }],
    student_previous_schools: [],
    student_activities: [],
    student_flags: [],
    graduated_from_class: null,
    // What Prisma would return: the relation only when the query asked for it.
    ...(include?.student_category_assignments ? { student_category_assignments: ASSIGNMENTS } : {}),
  }));
  const prisma: any = new Proxy(
    { students: { findFirst } },
    { get: (t: any, k) => t[k] ?? new Proxy({}, { get: () => jest.fn(async () => null) }) },
  );
  const scope = { whereForStudents: () => ({}) };
  const service = new StudentsService(prisma, {} as any, {} as any, {} as any, {} as any, scope as any);
  (service as any).getFinancialDigest = async () => ({});
  return { service, findFirst };
}

describe('GET /students/:cc special categories (TAFSD-583)', () => {
  it('loads the category assignments and returns them', async () => {
    const { service, findFirst } = build();
    const s: any = await service.findOne(8141);
    expect(findFirst.mock.calls[0][0].include.student_category_assignments).toBeTruthy();
    expect(s.categories).toEqual([
      expect.objectContaining({ key: 'FEE_ENDOWMENT', until: '2027-07-31', remind_from: '2027-07-01', reason: 'Orphan' }),
    ]);
    expect(s.is_fee_endowment).toBe(true);
    expect(s.fee_endowment_until).toBe('2027-07-31');
    expect(s.is_complementary).toBe(false);
  });
});
