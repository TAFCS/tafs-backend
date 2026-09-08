import { TimetablesService } from './timetables.service';

describe('TimetablesService - deleteSlot', () => {
  const makeService = (prismaOverrides: Record<string, unknown> = {}) => {
    const tx = {
      class_session_reschedules: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      staff_lesson_reschedules: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      attendance_roll_sessions: {
        findUnique: jest.fn(),
        delete: jest.fn(),
      },
      attendance_roll_records: {
        deleteMany: jest.fn(),
      },
      timetable_slots: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        delete: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    const prisma = {
      timetable_slots: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        deleteMany: jest.fn(),
      },
      $transaction: jest.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
      ...prismaOverrides,
    };

    const auditLogs = {
      log: jest.fn().mockResolvedValue(undefined),
    };

    const classPeriods = {} as any;

    const service = new TimetablesService(
      prisma as any,
      auditLogs as any,
      classPeriods,
    );

    return { service, prisma, tx, auditLogs };
  };

  const user = {
    sub: '1',
    campusId: 1,
    role: 'SUPER_ADMIN',
    allowedClassIds: null,
  } as any;

  it('deletes primary slot and cleans up associated reschedules in a transaction', async () => {
    const { service, prisma, tx } = makeService();

    prisma.timetable_slots.findUnique.mockResolvedValue({
      id: 351,
      timetable_id: 87,
      day_of_week: 3,
      block_number: 4,
      slot_order: 1,
      subject_id: 10,
      employee_id: 249,
      timetables: { campus_id: 1, class_id: 20 },
      subjects: { name: 'Mathematics' },
    });

    prisma.timetable_slots.findMany.mockResolvedValue([{ id: 351 }]);

    tx.class_session_reschedules.findMany.mockResolvedValue([
      { id: 69, makeup_roll_session_id: 101 },
    ]);
    tx.class_session_reschedules.count.mockResolvedValue(0);
    tx.attendance_roll_sessions.findUnique.mockResolvedValue({ id: 101, status: 'DRAFT' });

    const result = await service.deleteSlot(351, user);

    expect(result).toEqual({ deleted: true, cascaded: true });
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(tx.attendance_roll_records.deleteMany).toHaveBeenCalledWith({ where: { session_id: 101 } });
    expect(tx.attendance_roll_sessions.delete).toHaveBeenCalledWith({ where: { id: 101 } });
    expect(tx.class_session_reschedules.updateMany).toHaveBeenCalledWith({
      where: { makeup_timetable_slot_id: { in: [351] } },
      data: { makeup_timetable_slot_id: null },
    });
    expect(tx.class_session_reschedules.deleteMany).toHaveBeenCalledWith({
      where: { source_timetable_slot_id: { in: [351] } },
    });
    expect(tx.timetable_slots.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [351] } },
    });
  });

  it('deletes split slot and cleans up reschedules while reordering higher split slots', async () => {
    const { service, prisma, tx } = makeService();

    prisma.timetable_slots.findUnique.mockResolvedValue({
      id: 352,
      timetable_id: 87,
      day_of_week: 3,
      block_number: 4,
      slot_order: 2,
      subject_id: 11,
      employee_id: 250,
      timetables: { campus_id: 1, class_id: 20 },
      subjects: { name: 'Physics' },
    });

    tx.timetable_slots.findMany.mockResolvedValue([
      { id: 353, slot_order: 3 },
    ]);

    const result = await service.deleteSlot(352, user);

    expect(result).toEqual({ deleted: true, cascaded: false });
    expect(tx.class_session_reschedules.updateMany).toHaveBeenCalledWith({
      where: { makeup_timetable_slot_id: { in: [352] } },
      data: { makeup_timetable_slot_id: null },
    });
    expect(tx.class_session_reschedules.deleteMany).toHaveBeenCalledWith({
      where: { source_timetable_slot_id: { in: [352] } },
    });
    expect(tx.timetable_slots.delete).toHaveBeenCalledWith({ where: { id: 352 } });
    expect(tx.timetable_slots.update).toHaveBeenCalledWith({
      where: { id: 353 },
      data: { slot_order: 2 },
    });
  });
});
