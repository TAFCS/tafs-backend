import { NotFoundException } from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import { AuditLogsService, resolveAuditCategory } from './audit-logs.service';

describe('AuditLogsService - Employee Scoping and Categorization', () => {
  describe('resolveAuditCategory', () => {
    it('classifies biometric and zk mapping events as Device', () => {
      expect(
        resolveAuditCategory({
          entity_type: 'ZK_ATTENDANCE_MAPPING',
          action: 'CREATED',
        }),
      ).toBe('Device');

      expect(
        resolveAuditCategory({
          entity_type: 'DEVICE',
          action: 'UPDATED',
          note: 'Biometric template updated',
        }),
      ).toBe('Device');
    });

    it('classifies user, permission, password, and impersonation events as Access', () => {
      expect(
        resolveAuditCategory({
          entity_type: 'USER',
          action: 'CREATE',
        }),
      ).toBe('Access');

      expect(
        resolveAuditCategory({
          entity_type: 'PERMISSION',
          action: 'UPDATED',
        }),
      ).toBe('Access');

      expect(
        resolveAuditCategory({
          entity_type: 'EMPLOYEE',
          action: 'PASSWORD_RESET',
        }),
      ).toBe('Access');

      expect(
        resolveAuditCategory({
          entity_type: 'USER',
          action: 'IMPERSONATED',
          note: 'Staff impersonated user',
        }),
      ).toBe('Access');
    });

    it('classifies payroll runs, loans, security deposits, and increments as Payroll', () => {
      expect(
        resolveAuditCategory({
          entity_type: 'PAYROLL_RUN',
          action: 'LINE_UNFINALIZED',
        }),
      ).toBe('Payroll');

      expect(
        resolveAuditCategory({
          entity_type: 'EMPLOYEE',
          action: 'LOAN_CREATED',
        }),
      ).toBe('Payroll');

      expect(
        resolveAuditCategory({
          entity_type: 'EMPLOYEE',
          action: 'SECURITY_DEPOSIT_RETURNED',
        }),
      ).toBe('Payroll');

      expect(
        resolveAuditCategory({
          entity_type: 'EMPLOYEE',
          action: 'SALARY_INCREMENT',
        }),
      ).toBe('Payroll');
    });

    it('classifies staff attendance, shift overrides, objections, and recomputes as Attendance', () => {
      expect(
        resolveAuditCategory({
          entity_type: 'STAFF_ATTENDANCE',
          action: 'OVERRIDE',
        }),
      ).toBe('Attendance');

      expect(
        resolveAuditCategory({
          entity_type: 'EMPLOYEE_SHIFT_OVERRIDE',
          action: 'CREATED',
        }),
      ).toBe('Attendance');

      expect(
        resolveAuditCategory({
          entity_type: 'ATTENDANCE_OBJECTION',
          action: 'ACCEPTED',
        }),
      ).toBe('Attendance');

      expect(
        resolveAuditCategory({
          entity_type: 'EMPLOYEE',
          action: 'ATTENDANCE_RECOMPUTE',
        }),
      ).toBe('Attendance');
    });

    it('classifies employee profile and timing updates as Profile', () => {
      expect(
        resolveAuditCategory({
          entity_type: 'EMPLOYEE',
          action: 'UPDATED',
          field: 'job_title',
        }),
      ).toBe('Profile');

      expect(
        resolveAuditCategory({
          entity_type: 'EMPLOYEE',
          action: 'UPDATED',
          field: 'reporting_time',
        }),
      ).toBe('Profile');

      expect(
        resolveAuditCategory({
          entity_type: 'EMPLOYEE',
          action: 'UPDATED',
          field: 'monthly_pay',
        }),
      ).toBe('Profile');
    });
  });

  describe('findAll employee-scoped', () => {
    let service: AuditLogsService;
    let mockPrisma: any;
    let mockScope: any;

    beforeEach(() => {
      mockPrisma = {
        employee_profiles: {
          findUnique: jest.fn(),
          findMany: jest.fn().mockResolvedValue([]),
        },
        device_user_mappings: {
          findMany: jest.fn().mockResolvedValue([]),
        },
        attendance_objections: {
          findMany: jest.fn().mockResolvedValue([]),
        },
        employee_shift_overrides: {
          findMany: jest.fn().mockResolvedValue([]),
        },
        audit_logs: {
          findMany: jest.fn().mockResolvedValue([]),
        },
        users: {
          findMany: jest.fn().mockResolvedValue([]),
        },
        classes: {
          findMany: jest.fn().mockResolvedValue([]),
        },
        campuses: {
          findMany: jest.fn().mockResolvedValue([]),
        },
        sections: {
          findMany: jest.fn().mockResolvedValue([]),
        },
        houses: {
          findMany: jest.fn().mockResolvedValue([]),
        },
      };

      mockScope = {
        isExempt: jest.fn().mockReturnValue(true),
        isUnrestricted: jest.fn().mockReturnValue(true),
        assertEmployee: jest.fn(),
      };

      service = new AuditLogsService(mockPrisma, mockScope);
    });

    it('throws NotFoundException when employee does not exist', async () => {
      mockPrisma.employee_profiles.findUnique.mockResolvedValue(null);

      await expect(
        service.findAll({ employee_id: 999 }, { role: StaffRole.SUPER_ADMIN }),
      ).rejects.toThrow(NotFoundException);
    });

    it('asserts scope when caller is scope restricted', async () => {
      const employee = {
        id: 42,
        user_id: 'usr_42',
        full_name: 'John Doe',
        employee_code: 'EMP-042',
        campus_id: 1,
        segment_id: null,
        department_id: null,
        staff_category_id: null,
      };
      mockPrisma.employee_profiles.findUnique.mockResolvedValue(employee);
      mockScope.isExempt.mockReturnValue(false);
      mockScope.isUnrestricted.mockReturnValue(false);

      await service.findAll({ employee_id: 42 }, { role: StaffRole.CAMPUS_ADMIN } as any);

      expect(mockScope.assertEmployee).toHaveBeenCalledWith(expect.anything(), employee);
    });

    it('retrieves employee logs, groups nested children, computes category, and respects category filtering', async () => {
      const employee = {
        id: 42,
        user_id: 'usr_42',
        full_name: 'John Doe',
        employee_code: 'EMP-042',
        campus_id: 1,
        segment_id: null,
        department_id: null,
        staff_category_id: null,
      };
      mockPrisma.employee_profiles.findUnique.mockResolvedValue(employee);

      const logs = [
        {
          id: 1,
          entity_type: 'EMPLOYEE',
          entity_id: '42',
          action: 'UPDATED',
          field: 'job_title',
          old_value: 'Teacher',
          new_value: 'Senior Teacher',
          changed_by: 'admin',
          changed_at: new Date('2026-10-25T10:00:00Z'),
          note: null,
          student_id: null,
          section: 'hr',
          parent_id: null,
        },
        {
          id: 2,
          entity_type: 'STAFF_ATTENDANCE',
          entity_id: '42',
          action: 'OVERRIDE',
          field: 'status',
          old_value: 'ABSENT',
          new_value: 'PRESENT',
          changed_by: 'admin',
          changed_at: new Date('2026-10-24T10:00:00Z'),
          note: null,
          student_id: null,
          section: 'attendance',
          parent_id: null,
        },
      ];
      mockPrisma.audit_logs.findMany.mockResolvedValue(logs);

      // Without category filter -> returns both
      const resAll = await service.findAll({ employee_id: 42 }, { role: StaffRole.SUPER_ADMIN });
      expect(resAll.total).toBe(2);
      expect(resAll.data[0].category).toBe('Profile');
      expect(resAll.data[1].category).toBe('Attendance');

      // With category filter for Attendance
      const resAtt = await service.findAll(
        { employee_id: 42, category: 'Attendance' },
        { role: StaffRole.SUPER_ADMIN },
      );
      expect(resAtt.total).toBe(1);
      expect(resAtt.data[0].id).toBe(2);
      expect(resAtt.data[0].category).toBe('Attendance');
    });
  });
});
