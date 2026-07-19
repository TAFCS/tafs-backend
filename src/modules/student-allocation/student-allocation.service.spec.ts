import { BadRequestException, ConflictException } from '@nestjs/common';
import { SectionGenderMode } from '@prisma/client';
import { normalizeGender } from './gender-normalization';
import { StudentAllocationService } from './student-allocation.service';

describe('normalizeGender', () => {
  it('normalizes common male/female values', () => {
    expect(normalizeGender('Male')).toBe('MALE');
    expect(normalizeGender('female')).toBe('FEMALE');
    expect(normalizeGender('BOY')).toBe('MALE');
    expect(normalizeGender('girls')).toBe('FEMALE');
  });

  it('returns UNKNOWN for blank or unrecognized values', () => {
    expect(normalizeGender(null)).toBe('UNKNOWN');
    expect(normalizeGender('')).toBe('UNKNOWN');
    expect(normalizeGender('other')).toBe('UNKNOWN');
  });
});

describe('StudentAllocationService.assertGenderAllowed', () => {
  const service = new StudentAllocationService({} as any);

  it('allows any gender for COED', () => {
    expect(() =>
      service.assertGenderAllowed(SectionGenderMode.COED, null),
    ).not.toThrow();
    expect(() =>
      service.assertGenderAllowed(SectionGenderMode.COED, 'Male'),
    ).not.toThrow();
  });

  it('rejects missing gender for restricted modes', () => {
    expect(() =>
      service.assertGenderAllowed(SectionGenderMode.BOYS_ONLY, null),
    ).toThrow(BadRequestException);
  });

  it('enforces boys-only and girls-only', () => {
    expect(() =>
      service.assertGenderAllowed(SectionGenderMode.BOYS_ONLY, 'Male'),
    ).not.toThrow();
    expect(() =>
      service.assertGenderAllowed(SectionGenderMode.BOYS_ONLY, 'Female'),
    ).toThrow(BadRequestException);
    expect(() =>
      service.assertGenderAllowed(SectionGenderMode.GIRLS_ONLY, 'Female'),
    ).not.toThrow();
    expect(() =>
      service.assertGenderAllowed(SectionGenderMode.GIRLS_ONLY, 'Male'),
    ).toThrow(BadRequestException);
  });
});

describe('StudentAllocationService.assertPlacementAllowed', () => {
  function buildService(overrides: {
    campusClass?: any;
    campusSection?: any;
    enrolledCount?: number;
  }) {
    const prisma: any = {
      campus_classes: {
        findFirst: jest.fn().mockResolvedValue(overrides.campusClass ?? { id: 1 }),
      },
      campus_sections: {
        findUnique: jest.fn().mockResolvedValue(
          Object.prototype.hasOwnProperty.call(overrides, 'campusSection')
            ? overrides.campusSection
            : {
                id: 1,
                campus_id: 1,
                class_id: 2,
                section_id: 3,
                is_active: true,
                student_capacity: 2,
                gender_mode: SectionGenderMode.COED,
              },
        ),
      },
      students: {
        count: jest.fn().mockResolvedValue(overrides.enrolledCount ?? 0),
      },
    };
    return { service: new StudentAllocationService(prisma), prisma };
  }

  it('rejects inactive or missing offerings', async () => {
    const missing = buildService({ campusSection: null });
    await expect(
      missing.service.assertPlacementAllowed(
        { campusId: 1, classId: 2, sectionId: 3 },
        { gender: 'Male', countsTowardCapacity: true },
      ),
    ).rejects.toThrow(BadRequestException);

    const inactive = buildService({
      campusSection: {
        id: 1,
        campus_id: 1,
        class_id: 2,
        section_id: 3,
        is_active: false,
        student_capacity: null,
        gender_mode: SectionGenderMode.COED,
      },
    });
    await expect(
      inactive.service.assertPlacementAllowed(
        { campusId: 1, classId: 2, sectionId: 3 },
        { gender: 'Male', countsTowardCapacity: true },
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects full sections and allows unlimited capacity', async () => {
    const full = buildService({ enrolledCount: 2 });
    await expect(
      full.service.assertPlacementAllowed(
        { campusId: 1, classId: 2, sectionId: 3 },
        { gender: 'Male', countsTowardCapacity: true },
      ),
    ).rejects.toThrow(ConflictException);

    const unlimited = buildService({
      enrolledCount: 100,
      campusSection: {
        id: 1,
        campus_id: 1,
        class_id: 2,
        section_id: 3,
        is_active: true,
        student_capacity: null,
        gender_mode: SectionGenderMode.COED,
      },
    });
    await expect(
      unlimited.service.assertPlacementAllowed(
        { campusId: 1, classId: 2, sectionId: 3 },
        { gender: 'Male', countsTowardCapacity: true },
      ),
    ).resolves.toMatchObject({ student_capacity: null });
  });

  it('excludes the moving student from occupancy', async () => {
    const { service, prisma } = buildService({ enrolledCount: 1 });
    await service.assertPlacementAllowed(
      { campusId: 1, classId: 2, sectionId: 3 },
      { studentCc: 99, gender: 'Male', countsTowardCapacity: true },
    );
    expect(prisma.students.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          cc: { not: 99 },
        }),
      }),
    );
  });
});
