import { NotFoundException } from '@nestjs/common';
import { PostdatedChequesService } from './postdated-cheques.service';

const scopedUser = { sub: 'u1', role: 'EMPLOYEE', campusId: null, allowedClassIds: [] } as any;

function build(opts: { visibleStudent?: boolean; cheque?: unknown } = {}) {
  const prisma = {
    students: { findFirst: jest.fn().mockResolvedValue(opts.visibleStudent ? { cc: 1 } : null) },
    postdated_cheques: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(opts.cheque ?? null),
      create: jest.fn().mockResolvedValue({ id: 9 }),
      update: jest.fn(),
      delete: jest.fn(),
    },
  };
  const scope = { whereForStudents: jest.fn().mockReturnValue({ campus_id: { in: [3] } }) };
  const svc = new PostdatedChequesService(prisma as any, { log: jest.fn() } as any, scope as any);
  return { svc, prisma, scope };
}

describe('PostdatedChequesService scope', () => {
  it('narrows the list to the caller scope, ANDed with the requested campus filter', async () => {
    const { svc, prisma } = build();
    await svc.list({ campus_id: 3 }, scopedUser);
    const where = prisma.postdated_cheques.findMany.mock.calls[0][0].where;
    expect(where.students.AND).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ AND: expect.arrayContaining([{ campus_id: { in: [3] } }]) }),
        { campus_id: 3 },
      ]),
    );
  });

  it('applies scope to the due list and to one student\'s cheques', async () => {
    const { svc, prisma } = build();
    await svc.getDue(scopedUser);
    await svc.getByStudent(5, scopedUser);
    for (const call of prisma.postdated_cheques.findMany.mock.calls) {
      expect(call[0].where.students).toEqual({
        AND: [{ campus_id: { in: [3] } }, expect.any(Object)],
      });
    }
  });

  it('404s a cheque outside scope on read, status change and delete', async () => {
    const { svc } = build({ cheque: null });
    await expect(svc.findOne(1, scopedUser)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.updateStatus(1, { status: 'CASHED' } as any, 'x', scopedUser)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(svc.remove(1, 'x', scopedUser)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s recording a cheque for a student outside scope, and writes nothing', async () => {
    const { svc, prisma } = build({ visibleStudent: false });
    await expect(
      svc.create({ student_id: 1, cheque_number: '1', amount: 10, cheque_date: '2026-10-01', received_date: '2026-09-20' } as any, 'x', scopedUser),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.postdated_cheques.create).not.toHaveBeenCalled();
  });

  it('records a cheque for a visible student', async () => {
    const { svc, prisma } = build({ visibleStudent: true });
    await svc.create({ student_id: 1, cheque_number: '1', amount: 10, cheque_date: '2026-10-01', received_date: '2026-09-20' } as any, 'x', scopedUser);
    expect(prisma.postdated_cheques.create).toHaveBeenCalledTimes(1);
  });

  it('applies no filter for an internal caller with no user', async () => {
    const { svc, prisma } = build();
    await svc.getDue();
    expect(prisma.postdated_cheques.findMany.mock.calls[0][0].where.students).toEqual({});
  });
});
