jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

import { BadRequestException } from '@nestjs/common';
import { ParentChangeRequestsService, ACCOUNT_DELETION_REQUEST_TYPE } from './parent-change-requests.service';

describe('ParentChangeRequestsService duplicate prevention', () => {
  let service: ParentChangeRequestsService;

  const mockAuditLogs = { log: jest.fn().mockResolvedValue(undefined) };
  const mockAuthService = {} as any;
  const mockNoticeBoardService = {} as any;
  const mockScope = {
    isExempt: jest.fn().mockReturnValue(true),
    canSeeStudent: jest.fn().mockReturnValue(true),
    whereForStudents: jest.fn().mockReturnValue({}),
  } as any;

  let prisma: any;

  beforeEach(() => {
    prisma = {
      guardians: {
        findUnique: jest.fn().mockResolvedValue({ id: 7349, full_name: 'MUJTABA KHALIL FAROOQUI' }),
      },
      families: {
        findUnique: jest.fn().mockResolvedValue({ id: 3637, household_name: 'Farooqui' }),
      },
      students: {
        findUnique: jest.fn().mockResolvedValue({ cc: 7356, full_name: 'FATIMA FAROOQUI' }),
      },
      parent_change_requests: {
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };

    service = new ParentChangeRequestsService(
      prisma as any,
      mockAuthService,
      mockAuditLogs as any,
      mockNoticeBoardService,
      mockScope,
    );
  });

  it('creates a new request when no pending request exists', async () => {
    prisma.parent_change_requests.findMany.mockResolvedValue([]);
    prisma.parent_change_requests.create.mockResolvedValue({
      id: 101,
      guardian_id: 7349,
      family_id: 3637,
      requested_data: { photo_url: 'https://cdn/photo1.jpg' },
      status: 'PENDING',
    });

    const res = await service.createRequest({
      guardian_id: 7349,
      family_id: 3637,
      requested_data: { photo_url: 'https://cdn/photo1.jpg' },
    });

    expect(prisma.parent_change_requests.create).toHaveBeenCalledTimes(1);
    expect(prisma.parent_change_requests.update).not.toHaveBeenCalled();
    expect(res.id).toBe(101);
  });

  it('updates the existing pending request when submitting a duplicate guardian photo change', async () => {
    const existingPending = {
      id: 100,
      guardian_id: 7349,
      family_id: 3637,
      requested_data: { photo_url: 'https://cdn/photo1.jpg' },
      status: 'PENDING',
      created_at: new Date('2026-10-27T10:00:00Z'),
    };

    prisma.parent_change_requests.findMany.mockResolvedValue([existingPending]);
    prisma.parent_change_requests.update.mockResolvedValue({
      id: 100,
      guardian_id: 7349,
      family_id: 3637,
      requested_data: { photo_url: 'https://cdn/photo2.jpg' },
      status: 'PENDING',
      updated_at: new Date(),
    });

    const res = await service.createRequest({
      guardian_id: 7349,
      family_id: 3637,
      requested_data: { photo_url: 'https://cdn/photo2.jpg' },
    });

    expect(prisma.parent_change_requests.create).not.toHaveBeenCalled();
    expect(prisma.parent_change_requests.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 100 },
        data: expect.objectContaining({
          requested_data: { photo_url: 'https://cdn/photo2.jpg' },
        }),
      }),
    );
    expect(res.id).toBe(100);
    expect(mockAuditLogs.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'REQUESTED',
        entity_id: '100',
        note: expect.stringContaining('Change request #100 updated'),
      }),
    );
  });

  it('allows different kinds of guardian changes (e.g. photo and phone) to be pending simultaneously', async () => {
    const existingPendingPhoto = {
      id: 100,
      guardian_id: 7349,
      family_id: 3637,
      requested_data: { photo_url: 'https://cdn/photo1.jpg' },
      status: 'PENDING',
      created_at: new Date('2026-10-27T10:00:00Z'),
    };

    prisma.parent_change_requests.findMany.mockResolvedValue([existingPendingPhoto]);
    prisma.parent_change_requests.create.mockResolvedValue({
      id: 102,
      guardian_id: 7349,
      family_id: 3637,
      requested_data: { primary_phone: '3322920689', primary_phone_country_code: '+92' },
      status: 'PENDING',
    });

    const res = await service.createRequest({
      guardian_id: 7349,
      family_id: 3637,
      requested_data: { primary_phone: '3322920689', primary_phone_country_code: '+92' },
    });

    expect(prisma.parent_change_requests.create).toHaveBeenCalledTimes(1);
    expect(prisma.parent_change_requests.update).not.toHaveBeenCalled();
    expect(res.id).toBe(102);
  });

  it('updates the existing pending request when submitting a duplicate student change for the same student and field', async () => {
    const existingPendingStudent = {
      id: 200,
      guardian_id: 7349,
      family_id: 3637,
      requested_data: {
        request_type: 'STUDENT_UPDATE',
        student_cc: 7356,
        changes: { photograph_url: 'https://cdn/student1.jpg' },
      },
      status: 'PENDING',
      created_at: new Date('2026-10-27T10:00:00Z'),
    };

    prisma.parent_change_requests.findMany.mockResolvedValue([existingPendingStudent]);
    prisma.parent_change_requests.update.mockResolvedValue({
      id: 200,
      guardian_id: 7349,
      family_id: 3637,
      requested_data: {
        request_type: 'STUDENT_UPDATE',
        student_cc: 7356,
        changes: { photograph_url: 'https://cdn/student2.jpg' },
      },
      status: 'PENDING',
    });

    const res = await service.createRequest({
      guardian_id: 7349,
      family_id: 3637,
      requested_data: {
        request_type: 'STUDENT_UPDATE',
        student_cc: 7356,
        changes: { photograph_url: 'https://cdn/student2.jpg' },
      },
    });

    expect(prisma.parent_change_requests.create).not.toHaveBeenCalled();
    expect(prisma.parent_change_requests.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 200 },
        data: expect.objectContaining({
          requested_data: {
            request_type: 'STUDENT_UPDATE',
            student_cc: 7356,
            changes: { photograph_url: 'https://cdn/student2.jpg' },
          },
        }),
      }),
    );
    expect(res.id).toBe(200);
  });

  it('allows student changes for different students to be pending simultaneously', async () => {
    const existingPendingStudent = {
      id: 200,
      guardian_id: 7349,
      family_id: 3637,
      requested_data: {
        request_type: 'STUDENT_UPDATE',
        student_cc: 7356,
        changes: { photograph_url: 'https://cdn/student1.jpg' },
      },
      status: 'PENDING',
      created_at: new Date('2026-10-27T10:00:00Z'),
    };

    prisma.parent_change_requests.findMany.mockResolvedValue([existingPendingStudent]);
    prisma.parent_change_requests.create.mockResolvedValue({
      id: 205,
      guardian_id: 7349,
      family_id: 3637,
      requested_data: {
        request_type: 'STUDENT_UPDATE',
        student_cc: 8000,
        changes: { photograph_url: 'https://cdn/student_other.jpg' },
      },
      status: 'PENDING',
    });

    const res = await service.createRequest({
      guardian_id: 7349,
      family_id: 3637,
      requested_data: {
        request_type: 'STUDENT_UPDATE',
        student_cc: 8000,
        changes: { photograph_url: 'https://cdn/student_other.jpg' },
      },
    });

    expect(prisma.parent_change_requests.create).toHaveBeenCalledTimes(1);
    expect(prisma.parent_change_requests.update).not.toHaveBeenCalled();
    expect(res.id).toBe(205);
  });

  it('rejects duplicate account deletion requests with BadRequestException', async () => {
    const existingPendingDeletion = {
      id: 300,
      guardian_id: 7349,
      family_id: 3637,
      requested_data: {
        request_type: ACCOUNT_DELETION_REQUEST_TYPE,
        reason: 'Leaving school',
      },
      status: 'PENDING',
      created_at: new Date('2026-10-27T10:00:00Z'),
    };

    prisma.parent_change_requests.findMany.mockResolvedValue([existingPendingDeletion]);

    await expect(
      service.createRequest({
        guardian_id: 7349,
        family_id: 3637,
        requested_data: {
          request_type: ACCOUNT_DELETION_REQUEST_TYPE,
          reason: 'Leaving country',
        },
      }),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.parent_change_requests.create).not.toHaveBeenCalled();
    expect(prisma.parent_change_requests.update).not.toHaveBeenCalled();
  });
});
