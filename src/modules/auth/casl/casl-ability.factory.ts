import { Injectable } from '@nestjs/common';
import {
  AbilityBuilder,
  createMongoAbility,
  MongoAbility,
} from '@casl/ability';
import { StaffRole } from '@prisma/client';
import { Action } from './actions';
import { AppSubjects } from './subjects';
import {
  IJwtStaffPayload,
  IJwtParentPayload,
} from '../interfaces/jwt-payload.interface';

export type AppAbility = MongoAbility<[Action, AppSubjects]>;

@Injectable()
export class CaslAbilityFactory {
  createForStaff(user: IJwtStaffPayload): AppAbility {
    const { can, build } = new AbilityBuilder<AppAbility>(
      createMongoAbility,
    );

    // 1. Handle Super Admin (Unrestricted)
    if (user.role === StaffRole.SUPER_ADMIN) {
      can(Action.Manage, 'all');
      return build();
    }

    // 2. Map new permissions to CASL (for other roles)
    // This allows us to use existing @CheckPolicies decorators with Action and Subject
    const permissions = user.permissions || [];

    permissions.forEach((perm) => {
      if (!perm) return;

      const parts = perm.split('.').filter(Boolean);
      if (parts.length < 3) return;

      // attendance.staff.mark
      if (parts[0] === 'attendance' && parts[1] === 'staff') {
        const subject: AppSubjects = 'StaffAttendance';
        if (user.campusId) {
          can(Action.Manage, subject, { campusId: user.campusId } as any);
          can(Action.Read, subject, { campusId: user.campusId } as any);
        } else {
          can(Action.Manage, subject);
          can(Action.Read, subject);
        }
        return;
      }

      // attendance.student.rollcall.mark / .view / .edit_locked
      if (parts[0] === 'attendance' && parts[1] === 'student') {
        const subAction = parts.slice(2).join('.');
        const caslAction =
          subAction === 'rollcall.view' || subAction === 'biometric.view' || subAction === 'reports.view'
            ? Action.Read
            : Action.Manage;
        const subject: AppSubjects = 'RollSession';
        if (user.campusId) {
          can(caslAction, subject, { campusId: user.campusId } as any);
        } else {
          can(caslAction, subject);
        }
        return;
      }

      const resource = parts[1];
      const action = parts.slice(2).join('.');
      if (!resource || !action) return;

      // Simple mapping logic: edit/create/manage maps to Manage, view maps to Read
      const caslAction =
        action === 'view' || action.endsWith('.view')
          ? Action.Read
          : Action.Manage;

      // Map permission resource keys to CASL Subjects
      let subjects: AppSubjects[] = [];
      switch (resource) {
        case 'campuses': subjects = ['Campus']; break;
        case 'classes': subjects = ['Class']; break;
        case 'sections': subjects = ['Section']; break;
        case 'registration':
        case 'enrollment':
        case 'directory': subjects = ['Student']; break;
        case 'families': subjects = ['Family']; break;
        case 'fee_types': subjects = ['Fee']; break;
        case 'classwise_schedule': subjects = ['ClassFeeSchedule']; break;
        case 'studentwise_schedule': subjects = ['StudentFee']; break;
        case 'vouchers': subjects = ['Voucher']; break;
        case 'deposits': subjects = ['Challan']; break; // 'deposits' UI uses Challan subject in guards
        case 'banks': subjects = ['Fee']; break; // Banks are part of fee admin
        case 'users': subjects = ['User']; break;
        case 'permissions': subjects = ['Permission']; break;
        case 'analytics': subjects = ['all']; break;
        case 'employees': subjects = ['Employee']; break;
        case 'policies': subjects = ['Policy', 'Calendar', 'ClassAttendanceMode']; break;
        case 'calendar': subjects = ['Calendar']; break;
        case 'support_tickets': subjects = ['SupportTicket']; break;
      }

      if (resource === 'support_tickets' && action === 'approve') {
        subjects.forEach((subject) => {
          can(Action.Manage, subject);
        });
        return;
      }

      subjects.forEach((subject) => {
        // Apply campus scoping for non-Super Admins
        const isAdminOrPrincipal = ([StaffRole.CAMPUS_ADMIN, StaffRole.PRINCIPAL] as StaffRole[]).includes(user.role);
        
        if (user.campusId && subject !== 'all' && subject !== 'User') {
           // For Student, Fee, Voucher, etc., restrict to campusId
           can(caslAction, subject, { campusId: user.campusId } as any);
        } else {
           can(caslAction, subject);
        }
      });
    });

    return build();
  }

  createForParent(user: IJwtParentPayload): AppAbility {
    const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);

    can(Action.Read, 'Student', { familyId: user.familyId } as any);
    can(Action.Read, 'Fee', { familyId: user.familyId } as any);
    can(Action.Read, 'Challan', { familyId: user.familyId } as any);
    can(Action.Read, 'Class');
    can(Action.Read, 'Section');
    can(Action.Read, 'SupportTicket');
    can(Action.Manage, 'SupportTicket');

    return build();
  }
}
