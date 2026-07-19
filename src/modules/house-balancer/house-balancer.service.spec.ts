import { BadRequestException, ConflictException } from '@nestjs/common';
import { HouseBalancerService } from './house-balancer.service';

describe('HouseBalancerService', () => {
  function buildService(opts?: {
    students?: any[];
    houses?: any[];
    offering?: any;
  }) {
    const students =
      opts?.students ??
      [
        { cc: 1, full_name: 'A', class_id: 2, section_id: 3, house_id: 10, houses: { id: 10, house_name: 'Red', house_color: '#f00' } },
        { cc: 2, full_name: 'B', class_id: 2, section_id: 3, house_id: 10, houses: { id: 10, house_name: 'Red', house_color: '#f00' } },
        { cc: 3, full_name: 'C', class_id: 2, section_id: 3, house_id: 11, houses: { id: 11, house_name: 'Blue', house_color: '#00f' } },
        { cc: 4, full_name: 'D', class_id: 2, section_id: 3, house_id: null, houses: null },
      ];
    const houses =
      opts?.houses ??
      [
        { id: 10, house_name: 'Red', house_color: '#f00' },
        { id: 11, house_name: 'Blue', house_color: '#00f' },
      ];

    const prisma: any = {
      campuses: {
        findUnique: jest.fn().mockResolvedValue({
          id: 1,
          campus_name: 'Main',
          campus_code: 'M',
        }),
      },
      classes: {
        findUnique: jest.fn().mockResolvedValue({
          id: 2,
          description: 'VII',
          class_code: 'VII',
        }),
      },
      sections: {
        findUnique: jest.fn().mockResolvedValue({ id: 3, description: 'A' }),
      },
      campus_sections: {
        findUnique: jest.fn().mockResolvedValue(
          opts?.offering ?? { id: 9, is_active: true },
        ),
        findMany: jest.fn().mockResolvedValue([
          {
            class_id: 2,
            section_id: 3,
            classes: { id: 2, description: 'VII', class_code: 'VII' },
            sections: { id: 3, description: 'A' },
          },
        ]),
      },
      houses: {
        findMany: jest.fn().mockResolvedValue(houses),
      },
      students: {
        findMany: jest.fn().mockResolvedValue(students),
        update: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn(async (fn: any) => {
        const tx = {
          $executeRaw: jest.fn().mockResolvedValue(undefined),
          campus_sections: {
            findMany: jest.fn().mockResolvedValue([
              { class_id: 2, section_id: 3 },
            ]),
            findUnique: jest.fn().mockResolvedValue({ id: 9, is_active: true }),
          },
          students: {
            findMany: jest.fn().mockResolvedValue(students),
            update: jest.fn().mockResolvedValue({}),
          },
        };
        return fn(tx);
      }),
      $executeRaw: jest.fn(),
    };

    const auditLogs = { log: jest.fn().mockResolvedValue(undefined) };
    return {
      service: new HouseBalancerService(prisma, auditLogs as any),
      prisma,
      auditLogs,
      students,
      houses,
    };
  }

  it('previews a balanced assignment without writing', async () => {
    const { service, prisma } = buildService();
    const preview = await service.preview({
      campus_id: 1,
      class_id: 2,
      section_id: 3,
    });

    expect(preview.student_count).toBe(4);
    expect(preview.assignments).toHaveLength(4);
    const counts = Object.values(preview.proposed_counts);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    expect(prisma.students.update).not.toHaveBeenCalled();
    expect(preview.roster_fingerprint).toHaveLength(64);
  });

  it('rejects empty roster and missing houses', async () => {
    const empty = buildService({ students: [] });
    await expect(
      empty.service.preview({ campus_id: 1, class_id: 2, section_id: 3 }),
    ).rejects.toThrow(BadRequestException);

    const noHouses = buildService({ houses: [] });
    await expect(
      noHouses.service.preview({ campus_id: 1, class_id: 2, section_id: 3 }),
    ).rejects.toThrow(BadRequestException);
  });

  it('applies assignments atomically and rejects stale previews', async () => {
    const { service, auditLogs, students } = buildService();
    const preview = await service.preview({
      campus_id: 1,
      class_id: 2,
      section_id: 3,
    });

    const applied = await service.apply(
      {
        campus_id: 1,
        class_id: 2,
        section_id: 3,
        roster_fingerprint: preview.roster_fingerprint,
        assignments: preview.assignments.map((a) => ({
          student_id: a.student_id,
          house_id: a.proposed_house.id,
        })),
      },
      'tester',
    );

    expect(applied.student_count).toBe(students.length);
    expect(auditLogs.log).toHaveBeenCalled();

    await expect(
      service.apply(
        {
          campus_id: 1,
          class_id: 2,
          section_id: 3,
          roster_fingerprint: 'not-the-real-fingerprint',
          assignments: preview.assignments.map((a) => ({
            student_id: a.student_id,
            house_id: a.proposed_house.id,
          })),
        },
        'tester',
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('previews and applies all populated class/section groups for a campus', async () => {
    const { service, auditLogs, students } = buildService();
    const preview = await service.previewCampus({ campus_id: 1 });

    expect(preview.group_count).toBe(1);
    expect(preview.total_students).toBe(students.length);
    expect(preview.groups[0].class.id).toBe(2);
    expect(preview.groups[0].section.id).toBe(3);

    const applied = await service.applyCampus(
      {
        campus_id: 1,
        campus_fingerprint: preview.campus_fingerprint,
        groups: preview.groups.map((group) => ({
          class_id: group.class.id,
          section_id: group.section.id,
          roster_fingerprint: group.roster_fingerprint,
          assignments: group.assignments.map((assignment) => ({
            student_id: assignment.student_id,
            house_id: assignment.proposed_house.id,
          })),
        })),
      },
      'tester',
    );

    expect(applied.total_students).toBe(students.length);
    expect(applied.group_count).toBe(1);
    expect(auditLogs.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'CAMPUS_REBALANCED' }),
    );
  });
});
