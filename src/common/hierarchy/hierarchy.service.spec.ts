import { EmployeeStatus } from '@prisma/client';
import { HierarchyService, HIERARCHY_CONFIG_PREFIX, LEGACY_ENFORCE_KEY } from './hierarchy.service';

describe('HierarchyService', () => {
  let service: HierarchyService;
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      app_config: {
        findUnique: jest.fn(),
        upsert: jest.fn().mockResolvedValue({}),
      },
      employee_profiles: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
      employee_reporting_lines: {
        findMany: jest.fn(),
      },
    };
    service = new HierarchyService(mockPrisma);
  });

  describe('isExempt', () => {
    it('returns true for SUPER_ADMIN and DEVELOPER', () => {
      expect(service.isExempt({ role: 'SUPER_ADMIN' })).toBe(true);
      expect(service.isExempt({ role: 'DEVELOPER' })).toBe(true);
      expect(service.isExempt({ role: 'CAMPUS_ADMIN' })).toBe(false);
      expect(service.isExempt({ role: 'TEACHER' })).toBe(false);
      expect(service.isExempt(null)).toBe(false);
      expect(service.isExempt(undefined)).toBe(false);
    });
  });

  describe('below and userIdsBelow', () => {
    it('returns empty array if user has no active employee profile', async () => {
      mockPrisma.employee_profiles.findMany.mockResolvedValue([]);
      mockPrisma.employee_profiles.findUnique.mockResolvedValue(null);
      expect(await service.below('u-missing')).toEqual([]);
      expect(await service.userIdsBelow('u-missing')).toEqual([]);
    });

    it('returns all descendants across multiple levels', async () => {
      // Tree: 1 (u-1) -> 2 (u-2) -> 3 (u-3) -> 4 (u-4)
      mockPrisma.employee_profiles.findMany.mockResolvedValue([
        { id: 1, user_id: 'u-1' },
        { id: 2, user_id: 'u-2' },
        { id: 3, user_id: 'u-3' },
        { id: 4, user_id: 'u-4' },
      ]);
      mockPrisma.employee_profiles.findUnique.mockResolvedValue({
        id: 1,
        employment_status: EmployeeStatus.ACTIVE,
      });
      mockPrisma.employee_reporting_lines.findMany.mockResolvedValue([
        { manager_id: 1, employee_id: 2 },
        { manager_id: 2, employee_id: 3 },
        { manager_id: 3, employee_id: 4 },
      ]);

      const subs = await service.below('u-1');
      expect(subs).toEqual([2, 3, 4]);

      const userIds = await service.userIdsBelow('u-1');
      expect(userIds).toEqual(['u-2', 'u-3', 'u-4']);
    });

    it('respects depth constraint', async () => {
      mockPrisma.employee_profiles.findMany.mockResolvedValue([
        { id: 1, user_id: 'u-1' },
        { id: 2, user_id: 'u-2' },
        { id: 3, user_id: 'u-3' },
      ]);
      mockPrisma.employee_profiles.findUnique.mockResolvedValue({
        id: 1,
        employment_status: EmployeeStatus.ACTIVE,
      });
      mockPrisma.employee_reporting_lines.findMany.mockResolvedValue([
        { manager_id: 1, employee_id: 2 },
        { manager_id: 2, employee_id: 3 },
      ]);

      expect(await service.below('u-1', { depth: 1 })).toEqual([2]);
      expect(await service.below('u-1', { depth: 2 })).toEqual([2, 3]);
    });

    it('is cycle-safe and excludes caller and superiors', async () => {
      // Cycle: 1 -> 2 -> 1, plus 2 -> 3
      mockPrisma.employee_profiles.findMany.mockResolvedValue([
        { id: 2, user_id: 'u-2' },
      ]);
      mockPrisma.employee_profiles.findUnique.mockResolvedValue({
        id: 2,
        employment_status: EmployeeStatus.ACTIVE,
      });
      mockPrisma.employee_reporting_lines.findMany.mockResolvedValue([
        { manager_id: 1, employee_id: 2 },
        { manager_id: 2, employee_id: 1 },
        { manager_id: 2, employee_id: 3 },
      ]);

      // For user 2: 1 is a superior (cycle), so 1 is excluded; 3 is a subordinate.
      const subs = await service.below('u-2');
      expect(subs).toEqual([3]);
    });

    it('handles multiple managers for an employee', async () => {
      // 1 -> 3, 2 -> 3, 3 -> 4
      mockPrisma.employee_profiles.findMany.mockResolvedValue([
        { id: 1, user_id: 'u-1' },
        { id: 2, user_id: 'u-2' },
      ]);
      mockPrisma.employee_profiles.findUnique.mockResolvedValue({
        id: 1,
        employment_status: EmployeeStatus.ACTIVE,
      });
      mockPrisma.employee_reporting_lines.findMany.mockResolvedValue([
        { manager_id: 1, employee_id: 3 },
        { manager_id: 2, employee_id: 3 },
        { manager_id: 3, employee_id: 4 },
      ]);

      expect(await service.below('u-1')).toEqual([3, 4]);
    });
  });

  describe('above', () => {
    it('returns all managers in the upward chain', async () => {
      mockPrisma.employee_profiles.findMany.mockResolvedValue([
        { id: 4, user_id: 'u-4' },
      ]);
      mockPrisma.employee_profiles.findUnique.mockResolvedValue({
        id: 4,
        employment_status: EmployeeStatus.ACTIVE,
      });
      mockPrisma.employee_reporting_lines.findMany.mockResolvedValue([
        { manager_id: 1, employee_id: 2 },
        { manager_id: 2, employee_id: 4 },
        { manager_id: 3, employee_id: 4 },
      ]);

      const superiors = await service.above('u-4');
      // Should include direct managers 2 and 3, and ancestor 1
      expect(superiors).toContain(2);
      expect(superiors).toContain(3);
      expect(superiors).toContain(1);
      expect(superiors).not.toContain(4);
    });
  });

  describe('isBelow', () => {
    it('returns true if target is in below array, false otherwise', async () => {
      mockPrisma.employee_profiles.findMany.mockResolvedValue([
        { id: 1, user_id: 'u-1' },
      ]);
      mockPrisma.employee_profiles.findUnique.mockResolvedValue({
        id: 1,
        employment_status: EmployeeStatus.ACTIVE,
      });
      mockPrisma.employee_reporting_lines.findMany.mockResolvedValue([
        { manager_id: 1, employee_id: 2 },
      ]);

      expect(await service.isBelow('u-1', 2)).toBe(true);
      expect(await service.isBelow('u-1', 1)).toBe(false); // self
      expect(await service.isBelow('u-1', 99)).toBe(false); // stranger
    });
  });

  describe('mode and setMode', () => {
    it('returns off by default', async () => {
      mockPrisma.app_config.findUnique.mockResolvedValue(null);
      expect(await service.mode('tickets_team')).toBe('off');
    });

    it('returns configured mode and caches it', async () => {
      mockPrisma.app_config.findUnique.mockResolvedValueOnce({ value: 'view' });
      expect(await service.mode('tickets_team')).toBe('view');

      // Second call uses cache
      expect(await service.mode('tickets_team')).toBe('view');
      expect(mockPrisma.app_config.findUnique).toHaveBeenCalledTimes(1);
    });

    it('falls back to legacy enforce key for attendance', async () => {
      mockPrisma.app_config.findUnique
        .mockResolvedValueOnce(null) // hierarchy.attendance
        .mockResolvedValueOnce({ value: 'true' }); // enforce_reporting_hierarchy

      expect(await service.mode('attendance')).toBe('enforce');
    });

    it('setMode updates app_config and clears cache', async () => {
      await service.setMode('attendance', 'enforce', 'admin-user');

      expect(mockPrisma.app_config.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { key: `${HIERARCHY_CONFIG_PREFIX}attendance` },
          create: expect.objectContaining({ value: 'enforce', updated_by: 'admin-user' }),
        }),
      );
      expect(mockPrisma.app_config.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { key: LEGACY_ENFORCE_KEY },
          create: expect.objectContaining({ value: 'true' }),
        }),
      );
    });
  });
});
