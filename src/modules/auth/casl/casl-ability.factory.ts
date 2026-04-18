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
      const [module, resource, action] = perm.split('.');

      // Simple mapping logic: edit/create/manage maps to Manage, view maps to Read
      const caslAction = (action === 'view') ? Action.Read : Action.Manage;

      // Map permission resource keys to CASL Subjects
      let subject: AppSubjects | null = null;
      switch (resource) {
        case 'campuses': subject = 'Campus'; break;
        case 'classes': subject = 'Class'; break;
        case 'sections': subject = 'Section'; break;
        case 'registration':
        case 'enrollment':
        case 'directory': subject = 'Student'; break;
        case 'families': subject = 'Family'; break;
        case 'fee_types': subject = 'Fee'; break;
        case 'classwise_schedule': subject = 'ClassFeeSchedule'; break;
        case 'studentwise_schedule': subject = 'StudentFee'; break;
        case 'vouchers': subject = 'Voucher'; break;
        case 'deposits': subject = 'Challan'; break; // 'deposits' UI uses Challan subject in guards
        case 'banks': subject = 'Fee'; break; // Banks are part of fee admin
        case 'users': subject = 'User'; break;
        case 'permissions': subject = 'Permission'; break;
        case 'analytics': subject = 'all'; break;
      }

      if (subject) {
        // Apply campus scoping for non-Super Admins
        const isAdminOrPrincipal = ([StaffRole.CAMPUS_ADMIN, StaffRole.PRINCIPAL] as StaffRole[]).includes(user.role);
        
        if (user.campusId && subject !== 'all' && subject !== 'User') {
           // For Student, Fee, Voucher, etc., restrict to campusId
           can(caslAction, subject, { campusId: user.campusId } as any);
        } else {
           can(caslAction, subject);
        }
      }
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

    return build();
  }
}
