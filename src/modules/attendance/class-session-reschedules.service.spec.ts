import { BadRequestException } from '@nestjs/common';
import { RollRecordStatus } from '@prisma/client';
import { ClassSessionReschedulesService } from './class-session-reschedules.service';

describe('ClassSessionReschedulesService', () => {
  describe('defaultSourceDate', () => {
    it('returns the most recent Monday before a Saturday makeup date', () => {
      const makeup = new Date('2026-09-06T00:00:00.000Z'); // Saturday
      const source = ClassSessionReschedulesService.defaultSourceDate(makeup, 1); // Monday
      expect(source.toISOString().slice(0, 10)).toBe('2026-08-31');
    });
  });

  const makeService = (prismaOverrides: Record<string, unknown> = {}) => {
    const prisma = {
      class_session_reschedules: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
      },
      attendance_roll_sessions: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      attendance_roll_records: {
        upsert: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
      },
      student_subject_enrollments: {
        findMany: jest.fn(),
      },
      timetable_slots: {
        count: jest.fn(),
      },
      teaching_groups: {
        findFirst: jest.fn(),
      },
      attendance_staff_daily: {
        upsert: jest.fn(),
        findUnique: jest.fn(),
        delete: jest.fn(),
      },
      $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
      ...prismaOverrides,
    };

    const rollSessions = {
      createMakeupSession: jest.fn(),
    };

    const staffLessonExcuse = {
      excuseTeacherForMissedLesson: jest.fn().mockResolvedValue({
        staffExcused: true,
        staffExcuseWarning: null,
      }),
      formatDateLabel: (d: Date) => d.toISOString().slice(0, 10),
    };

    const service = new ClassSessionReschedulesService(
      prisma as any,
      rollSessions as any,
      { list: jest.fn().mockResolvedValue([]) } as any,
      { log: jest.fn() } as any,
      { resolveStudentDay: jest.fn() } as any,
      staffLessonExcuse as any,
    );

    return { service, prisma, rollSessions, staffLessonExcuse };
  };

  describe('completeOnMakeupSubmit', () => {
    it('excuses only students present on the makeup session', async () => {
      const sourceDate = new Date('2026-08-31T00:00:00.000Z');
      const makeupDate = new Date('2026-09-06T00:00:00.000Z');
      const sourceSession = { id: 50, status: 'DRAFT' };

      const { service, prisma } = makeService();

      prisma.class_session_reschedules.findMany = jest.fn().mockResolvedValue([
        {
          id: 1,
          status: 'PENDING',
          source_date: sourceDate,
          makeup_date: makeupDate,
          teaching_group_id: 7,
          source_timetable_slot_id: 12,
          source_timetable_slot: { block_number: 2, subject_id: 3, employee_id: 5 },
          teaching_groups: { campus_id: 1, class_id: 20, subject_id: 3, employee_id: 5 },
        },
      ]);
      prisma.attendance_roll_sessions.findUnique.mockResolvedValue({
        id: 10,
        session_kind: 'MAKEUP',
        campus_id: 1,
        class_id: 20,
        section_id: null,
        snapshot_employee_id: 5,
        snapshot_subject_id: 3,
        attendance_roll_records: [
          { student_cc: 101, status: RollRecordStatus.PRESENT },
          { student_cc: 102, status: RollRecordStatus.ABSENT },
        ],
      });

      prisma.class_session_reschedules.findUnique.mockResolvedValue({
        id: 1,
        status: 'PENDING',
        source_date: sourceDate,
        makeup_date: makeupDate,
        teaching_group_id: 7,
        source_timetable_slot_id: 12,
        source_timetable_slot: { block_number: 2, subject_id: 3, employee_id: 5 },
        teaching_groups: { campus_id: 1, class_id: 20, subject_id: 3, employee_id: 5 },
      });

      prisma.attendance_roll_sessions.findFirst.mockResolvedValue(null);
      prisma.attendance_roll_sessions.create.mockResolvedValue(sourceSession);
      prisma.student_subject_enrollments.findMany.mockResolvedValue([
        { student_id: 101 },
        { student_id: 102 },
      ]);
      prisma.timetable_slots.count.mockResolvedValue(0);
      prisma.teaching_groups.findFirst.mockResolvedValue({ campus_id: 1 });
      prisma.class_session_reschedules.update.mockResolvedValue({});

      const user = { sub: 'u1', username: 'admin' } as any;
      const result = await service.completeOnMakeupSubmit(10, user);

      expect(result.excusedStudentCount).toBe(1);
      expect(result.absentStudentCount).toBe(1);
      expect(result.staffExcusedDays).toBe(1);
      expect(result.sourceCount).toBe(1);

      expect(prisma.attendance_roll_records.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            student_cc: 101,
            status: RollRecordStatus.EXCUSED,
            notes: 'Makeup held 2026-09-06',
          }),
        }),
      );
      expect(prisma.attendance_roll_records.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            student_cc: 102,
            status: RollRecordStatus.ABSENT,
          }),
        }),
      );
    });

    it('warns when teacher has other slots on the source day', async () => {
      const { service, prisma, staffLessonExcuse } = makeService();

      staffLessonExcuse.excuseTeacherForMissedLesson.mockResolvedValue({
        staffExcused: false,
        staffExcuseWarning:
          'Teacher has other timetable slots on the source day — staff register was not auto-updated. Mark manually in Staff Register.',
      });

      prisma.class_session_reschedules.findMany = jest.fn().mockResolvedValue([
        {
          id: 1,
          status: 'PENDING',
          source_date: new Date('2026-08-31T00:00:00.000Z'),
          makeup_date: new Date('2026-09-06T00:00:00.000Z'),
          teaching_group_id: 7,
          source_timetable_slot_id: 12,
          source_timetable_slot: { block_number: 2, subject_id: 3, employee_id: 5 },
          teaching_groups: { campus_id: 1, class_id: 20, subject_id: 3, employee_id: 5 },
        },
      ]);
      prisma.attendance_roll_sessions.findUnique.mockResolvedValue({
        id: 10,
        session_kind: 'MAKEUP',
        campus_id: 1,
        class_id: 20,
        section_id: null,
        snapshot_employee_id: 5,
        attendance_roll_records: [{ student_cc: 101, status: RollRecordStatus.PRESENT }],
      });

      prisma.class_session_reschedules.findUnique.mockResolvedValue({
        id: 1,
        status: 'PENDING',
        source_date: new Date('2026-08-31T00:00:00.000Z'),
        makeup_date: new Date('2026-09-06T00:00:00.000Z'),
        teaching_group_id: 7,
        source_timetable_slot_id: 12,
        source_timetable_slot: { block_number: 2, subject_id: 3, employee_id: 5 },
        teaching_groups: { campus_id: 1, class_id: 20, subject_id: 3, employee_id: 5 },
      });

      prisma.attendance_roll_sessions.findFirst.mockResolvedValue({ id: 50, status: 'DRAFT' });
      prisma.student_subject_enrollments.findMany.mockResolvedValue([{ student_id: 101 }]);
      prisma.timetable_slots.count.mockResolvedValue(2);
      prisma.class_session_reschedules.update.mockResolvedValue({});

      const result = await service.completeOnMakeupSubmit(10, { sub: 'u1' } as any);

      expect(result.staffExcusedDays).toBe(0);
      expect(result.staffExcuseWarnings[0]).toMatch(/other timetable slots/);
      expect(staffLessonExcuse.excuseTeacherForMissedLesson).toHaveBeenCalled();
    });
  });

  describe('create', () => {
    it('rejects future source dates', async () => {
      const tomorrow = new Date();
      tomorrow.setUTCHours(0, 0, 0, 0);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      const tomorrowIso = tomorrow.toISOString().slice(0, 10);

      const { service, prisma } = makeService();
      prisma.teaching_groups = {
        findUnique: jest.fn().mockResolvedValue({
          id: 7,
          campus_id: 1,
          class_id: 20,
          academic_year: '2026-2027',
        }),
      } as any;
      prisma.timetable_slots = {
        findUnique: jest.fn().mockResolvedValue({
          id: 12,
          block_number: 2,
          day_of_week: tomorrow.getUTCDay(),
          timetables: {
            teaching_group_id: 7,
            effective_from: new Date('2026-08-01T00:00:00.000Z'),
          },
        }),
      } as any;

      await expect(
        service.create(
          {
            campus_id: 1,
            class_id: 20,
            teaching_group_id: 7,
            sources: [{ source_timetable_slot_id: 12, source_date: tomorrowIso }],
            makeup_date: '2026-09-10',
            makeup_period: 2,
          },
          { campusId: 1, classIds: [20], sub: 'u1' } as any,
        ),
      ).rejects.toThrow('Source date');
    });

    it('rejects source dates on or after the makeup date', async () => {
      const { service, prisma } = makeService();
      prisma.teaching_groups = {
        findUnique: jest.fn().mockResolvedValue({
          id: 7,
          campus_id: 1,
          class_id: 20,
          academic_year: '2026-2027',
        }),
      } as any;
      prisma.timetable_slots = {
        findUnique: jest.fn().mockResolvedValue({
          id: 12,
          block_number: 2,
          day_of_week: 6,
          timetables: {
            teaching_group_id: 7,
            effective_from: new Date('2026-08-01T00:00:00.000Z'),
          },
        }),
      } as any;

      await expect(
        service.create(
          {
            campus_id: 1,
            class_id: 20,
            teaching_group_id: 7,
            sources: [{ source_timetable_slot_id: 12, source_date: '2026-08-15' }],
            makeup_date: '2026-08-10',
            makeup_period: 7,
          },
          { campusId: 1, classIds: [20], sub: 'u1' } as any,
        ),
      ).rejects.toThrow('before the makeup date');
    });
  });

  describe('cancel', () => {
    it('rejects cancelling a completed reschedule', async () => {
      const { service, prisma } = makeService();
      jest.spyOn(service, 'findOne').mockResolvedValue({
        id: 1,
        status: 'COMPLETED',
        teaching_groups: { campus_id: 1, class_id: 20 },
      } as any);

      await expect(service.cancel(1, { campusId: 1 } as any)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.class_session_reschedules.update).not.toHaveBeenCalled();
    });
  });
});
