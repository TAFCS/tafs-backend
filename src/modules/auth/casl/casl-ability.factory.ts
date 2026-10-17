import { Injectable } from '@nestjs/common';
import {
  AbilityBuilder,
  createMongoAbility,
  MongoAbility,
} from '@casl/ability';
import { StaffRole } from '@prisma/client';
import { Action } from './actions';
import { AppSubjects } from './subjects';
import { actionsCover, userHoldsTile } from '../../access/tiles.manifest';
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

    // Tile sub-permissions that guard StaffAttendance routes. The routes pair
    // @CheckPolicies with @RequireAnyAction, and the tile's capability list
    // only maps to Read Payroll, so without this a holder of the Resolve
    // action passes the tile guard and still gets "Forbidden resource" here.
    // The route's own @RequireAnyAction still decides who may call it.
    const heldActions = new Set(user.actions ?? []);
    if (
      actionsCover(heldActions, 'attendance.employee_attendance_cycle#mark') ||
      actionsCover(heldActions, 'hr.payroll#line_manage')
    ) {
      can(Action.Manage, 'StaffAttendance');
      can(Action.Read, 'StaffAttendance');
    } else if (actionsCover(heldActions, 'attendance.employee_attendance_cycle#view')) {
      can(Action.Read, 'StaffAttendance');
    }

    // Shared routes whose coarse check names a subject the calling tile's own
    // capabilities do not map to. These used to pass only because the Staff
    // App self-service keys (held by every employee) mapped to Read
    // StaffAttendance / Manage Timetable -- which opened them to everyone
    // (TAFSD-374). Now only holders of the tiles whose pages call them pass;
    // each route's @RequireAction still decides exactly who.
    //   staff timeline / day history: Employee Directory, Timetables, Payroll
    //   lesson reschedules: Timetables
    if (['hr.employee_directory', 'attendance.timetables', 'hr.payroll'].some((t) => userHoldsTile(user, t))) {
      can(Action.Read, 'StaffAttendance');
    }
    //   teaching groups list / group day slots: A-Level Roll Call
    if (userHoldsTile(user, 'attendance.alevel_roll_call')) {
      can(Action.Read, 'Timetable');
    }

    // 2. Map new permissions to CASL (for other roles)
    // This allows us to use existing @CheckPolicies decorators with Action and Subject
    const permissions = user.permissions || [];

    permissions.forEach((perm) => {
      if (!perm) return;

      const parts = perm.split('.').filter(Boolean);
      if (parts.length === 2 && parts[0] === 'communication') {
        if (parts[1] === 'view_chats') {
          can(Action.Read, 'Chat');
        }
        if (parts[1] === 'send_announcements') {
          can(Action.Manage, 'Chat');
        }
        if (parts[1] === 'send_employee_announcements') {
          can(Action.Manage, 'EmployeeNotice');
          can(Action.Read, 'EmployeeNotice');
        }
        return;
      }
      
      // attendance.staff.mark
      if (parts[0] === 'attendance' && parts[1] === 'staff') {
        const subject: AppSubjects = 'StaffAttendance';
        can(Action.Manage, subject);
        can(Action.Read, subject);
        return;
      }

      // Staff App self-service keys (every employee holds them through the
      // self-service pack). The self routes check these raw keys themselves
      // (assertStaffSelfPermission); mapping them to Read StaffAttendance /
      // Read Payroll / Manage Timetable opened the ERP's own routes to every
      // employee (TAFSD-374), so they grant no CASL ability at all.
      if (
        perm === 'attendance.self.view' ||
        perm === 'payroll.self.view' ||
        perm === 'hr.timetable.self_view' ||
        perm === 'hr.leave.apply'
      ) {
        return;
      }

      if (perm === 'hr.objections.review') {
        can(Action.Manage, 'StaffAttendance');
        return;
      }

      // finance.vouchers.release is its own subject so it does not grant
      // Manage on Voucher (create/edit/delete) via the generic 3-part mapper.
      if (parts[0] === 'finance' && parts[1] === 'vouchers' && parts[2] === 'release') {
        can(Action.Manage, 'VoucherRelease');
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
        can(caslAction, subject);
        return;
      }

      const [module, resource, action] = parts.length >= 3
        ? [parts[0], parts[1], parts.slice(2).join('.')]
        : [parts[0], parts[1], parts[1]];

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
        case 'payroll': subjects = ['Payroll']; break;
        case 'calendar': subjects = ['Calendar']; break;
        case 'support_tickets': subjects = ['SupportTicket']; break;
        case 'timetable': subjects = ['Timetable']; break;
      }

      if (resource === 'support_tickets' && action === 'approve') {
        subjects.forEach((subject) => {
          can(Action.Manage, subject);
        });
        return;
      }

      // CASL answers "may this person do X to Y at all". Which campuses'
      // records they may touch is the universal scope's job (ScopeService),
      // never a campus condition here.
      subjects.forEach((subject) => can(caslAction, subject));
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
