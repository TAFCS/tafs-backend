import { StaffEditingService } from './staff-editing.service';
import { MediaService } from '../media/media.service';

describe('Student Photo History', () => {
  describe('StaffEditingService.getStudentPhotoHistory', () => {
    let service: StaffEditingService;
    let prisma: any;

    beforeEach(() => {
      prisma = {
        student_photo_history: {
          findMany: jest.fn(),
        },
        students: {
          findUnique: jest.fn(),
        },
      };

      // Instantiate service with mocked dependencies
      service = new StaffEditingService(
        prisma,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );
    });

    it('returns the same URL for first and latest when student has only one photo', async () => {
      prisma.student_photo_history.findMany.mockResolvedValue([
        {
          id: 1,
          student_id: 101,
          url: 'https://cdn.example.com/photos/101-initial.jpg',
          photo_type: 'standard',
          uploaded_by: 'system_backfill',
          uploaded_at: new Date('2024-01-15T10:00:00Z'),
        },
      ]);

      const result = await service.getStudentPhotoHistory(101);

      expect(result.first_photo_url).toBe('https://cdn.example.com/photos/101-initial.jpg');
      expect(result.latest_photo_url).toBe('https://cdn.example.com/photos/101-initial.jpg');
      expect(result.first_photo_url).toBe(result.latest_photo_url);
      expect(result.first_photo_date).toBe('2024-01-15');
      expect(result.latest_photo_date).toBe('2024-01-15');
    });

    it('returns different URLs for first and latest after two uploads', async () => {
      const firstPhotoUrl = 'https://cdn.example.com/photos/101-first.jpg';
      const secondPhotoUrl = 'https://cdn.example.com/photos/101-second.jpg';

      prisma.student_photo_history.findMany.mockResolvedValue([
        {
          id: 1,
          student_id: 101,
          url: firstPhotoUrl,
          photo_type: 'standard',
          uploaded_by: 'admission_officer',
          uploaded_at: new Date('2024-01-15T10:00:00Z'),
        },
        {
          id: 2,
          student_id: 101,
          url: secondPhotoUrl,
          photo_type: 'standard',
          uploaded_by: 'staff_editor',
          uploaded_at: new Date('2026-10-26T12:00:00Z'),
        },
      ]);

      const result = await service.getStudentPhotoHistory(101);

      expect(result.first_photo_url).toBe(firstPhotoUrl);
      expect(result.latest_photo_url).toBe(secondPhotoUrl);
      expect(result.first_photo_url).not.toBe(result.latest_photo_url);
      expect(result.first_photo_date).toBe('2024-01-15');
      expect(result.latest_photo_date).toBe('2026-10-26');
    });

    it('falls back to currentPhoto when no history rows exist yet', async () => {
      prisma.student_photo_history.findMany.mockResolvedValue([]);

      const result = await service.getStudentPhotoHistory(
        102,
        'https://cdn.example.com/photos/102-legacy.jpg',
        new Date('2023-08-20T00:00:00Z'),
      );

      expect(result.first_photo_url).toBe('https://cdn.example.com/photos/102-legacy.jpg');
      expect(result.latest_photo_url).toBe('https://cdn.example.com/photos/102-legacy.jpg');
      expect(result.first_photo_url).toBe(result.latest_photo_url);
      expect(result.first_photo_date).toBe('2023-08-20');
      expect(result.latest_photo_date).toBe('2023-08-20');
    });

    it('returns nulls when no photo exists', async () => {
      prisma.student_photo_history.findMany.mockResolvedValue([]);

      const result = await service.getStudentPhotoHistory(103, null, null);

      expect(result.first_photo_url).toBeNull();
      expect(result.latest_photo_url).toBeNull();
      expect(result.first_photo_date).toBeNull();
      expect(result.latest_photo_date).toBeNull();
    });
  });

  describe('StaffEditingService.listStudentPhotoHistory', () => {
    let service: StaffEditingService;
    let prisma: any;

    beforeEach(() => {
      prisma = {
        student_photo_history: {
          findMany: jest.fn(),
        },
        students: {
          findUnique: jest.fn(),
        },
      };

      service = new StaffEditingService(
        prisma,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );
    });

    it('returns history rows when present', async () => {
      const mockHistory = [
        {
          id: 1,
          student_id: 101,
          url: 'https://cdn.example.com/photos/101-1.jpg',
          photo_type: 'standard',
          uploaded_by: 'officer1',
          uploaded_at: new Date('2024-01-15T10:00:00Z'),
        },
        {
          id: 2,
          student_id: 101,
          url: 'https://cdn.example.com/photos/101-2.jpg',
          photo_type: 'standard',
          uploaded_by: 'officer2',
          uploaded_at: new Date('2025-06-20T10:00:00Z'),
        },
      ];
      prisma.student_photo_history.findMany.mockResolvedValue(mockHistory);

      const result = await service.listStudentPhotoHistory(101);
      expect(result).toEqual(mockHistory);
      expect(result.length).toBe(2);
    });

    it('returns backfilled row from student photograph_url when history is empty', async () => {
      prisma.student_photo_history.findMany.mockResolvedValue([]);
      prisma.students.findUnique.mockResolvedValue({
        cc: 105,
        photograph_url: 'https://cdn.example.com/photos/105-initial.jpg',
        doa: new Date('2022-09-01T00:00:00Z'),
        created_at: new Date('2022-09-01T00:00:00Z'),
      });

      const result = await service.listStudentPhotoHistory(105);
      expect(result.length).toBe(1);
      expect(result[0].url).toBe('https://cdn.example.com/photos/105-initial.jpg');
      expect(result[0].uploaded_by).toBe('system_backfill');
    });
  });

  describe('MediaService.uploadStudentPhoto history tracking', () => {
    let mediaService: MediaService;
    let prisma: any;
    let storage: any;
    let auditLogs: any;

    beforeEach(() => {
      prisma = {
        students: {
          findUnique: jest.fn().mockResolvedValue({ cc: 200, full_name: 'John Doe' }),
          update: jest.fn().mockResolvedValue({}),
        },
        student_photo_history: {
          create: jest.fn().mockResolvedValue({}),
        },
      };
      storage = {
        upload: jest.fn().mockResolvedValue('https://cdn.example.com/students/200/photo.jpg'),
      };
      auditLogs = {
        log: jest.fn().mockResolvedValue({}),
      };

      mediaService = new MediaService(prisma, storage, auditLogs);
    });

    it('creates a student_photo_history row on standard photo upload', async () => {
      const mockFile = {
        originalname: 'profile.jpg',
        buffer: Buffer.from('fake-data'),
        mimetype: 'image/jpeg',
      } as any;

      await mediaService.uploadStudentPhoto(200, mockFile, 'standard', false, 'test_user');

      expect(prisma.students.update).toHaveBeenCalledWith({
        where: { cc: 200 },
        data: { photograph_url: 'https://cdn.example.com/students/200/photo.jpg' },
      });

      expect(prisma.student_photo_history.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          student_id: 200,
          url: 'https://cdn.example.com/students/200/photo.jpg',
          photo_type: 'standard',
          uploaded_by: 'test_user',
        }),
      });
    });

    it('does not create a history row for temporary (parent) uploads', async () => {
      const mockFile = {
        originalname: 'profile.jpg',
        buffer: Buffer.from('fake-data'),
        mimetype: 'image/jpeg',
      } as any;

      await mediaService.uploadStudentPhoto(200, mockFile, 'standard', true, 'parent');

      expect(prisma.students.update).not.toHaveBeenCalled();
      expect(prisma.student_photo_history.create).not.toHaveBeenCalled();
    });
  });
});

