import { BadRequestException, NotFoundException } from '@nestjs/common';
import { HousesService } from './houses.service';

describe('HousesService', () => {
  let service: HousesService;
  let prisma: any;
  let auditLogs: any;

  beforeEach(() => {
    prisma = {
      houses: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      students: {
        count: jest.fn(),
      },
      $transaction: jest.fn((callbackOrPromises) => {
        if (typeof callbackOrPromises === 'function') {
          return callbackOrPromises(prisma);
        }
        return Promise.all(callbackOrPromises);
      }),
    };

    auditLogs = {
      log: jest.fn(),
      logGroup: jest.fn(),
    };

    service = new HousesService(prisma, auditLogs);
  });

  it('findAll filters active houses by default', async () => {
    prisma.houses.findMany.mockResolvedValue([{ id: 1, house_name: 'IQBAL', is_active: true }]);

    const result = await service.findAll();
    expect(prisma.houses.findMany).toHaveBeenCalledWith({
      where: { is_active: true },
      orderBy: { id: 'asc' },
    });
    expect(result).toHaveLength(1);
  });

  it('findAll includes inactive when requested', async () => {
    prisma.houses.findMany.mockResolvedValue([
      { id: 1, house_name: 'IQBAL', is_active: true },
      { id: 2, house_name: 'OLD HOUSE', is_active: false },
    ]);

    const result = await service.findAll({ includeInactive: true });
    expect(prisma.houses.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: { id: 'asc' },
    });
    expect(result).toHaveLength(2);
  });

  it('create creates a house with audit log', async () => {
    prisma.houses.create.mockResolvedValue({
      id: 5,
      house_name: 'NEW HOUSE',
      house_color: '#FF5733',
      is_active: true,
    });

    const result = await service.create({ house_name: 'NEW HOUSE', house_color: '#FF5733' }, 'admin');
    expect(result.id).toBe(5);
    expect(auditLogs.log).toHaveBeenCalledWith(expect.objectContaining({
      entity_type: 'HOUSE',
      entity_id: '5',
      action: 'CREATED',
    }));
  });

  it('update updates house fields and writes audit log', async () => {
    prisma.houses.findUnique.mockResolvedValue({
      id: 1,
      house_name: 'IQBAL',
      house_color: 'RED',
      is_active: true,
    });
    prisma.houses.update.mockResolvedValue({
      id: 1,
      house_name: 'IQBAL HOUSE',
      house_color: '#FF0000',
      is_active: false,
    });

    const result = await service.update(1, { house_name: 'IQBAL HOUSE', house_color: '#FF0000', is_active: false }, 'admin');
    expect(result.is_active).toBe(false);
    expect(auditLogs.log).toHaveBeenCalled();
  });

  it('delete blocks deletion if students are assigned and recommends deactivation', async () => {
    prisma.houses.findUnique.mockResolvedValue({
      id: 1,
      house_name: 'IQBAL',
      house_color: 'RED',
      is_active: true,
    });
    prisma.students.count.mockResolvedValue(15);

    await expect(service.delete(1, 'admin')).rejects.toThrow(BadRequestException);
    expect(prisma.houses.delete).not.toHaveBeenCalled();
  });

  it('delete succeeds if no students are assigned', async () => {
    prisma.houses.findUnique.mockResolvedValue({
      id: 5,
      house_name: 'EMPTY HOUSE',
      house_color: 'PURPLE',
      is_active: true,
    });
    prisma.students.count.mockResolvedValue(0);
    prisma.houses.delete.mockResolvedValue({ id: 5 });

    const result = await service.delete(5, 'admin');
    expect(result.id).toBe(5);
    expect(prisma.houses.delete).toHaveBeenCalledWith({ where: { id: 5 } });
    expect(auditLogs.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'DELETED',
    }));
  });
});
