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
    const { can, cannot, build } = new AbilityBuilder<AppAbility>(
      createMongoAbility,
    );

    switch (user.role) {
      case StaffRole.SUPER_ADMIN:
        // Unrestricted access across all campuses and resources
        can(Action.Manage, 'all');
        break;

      case StaffRole.CAMPUS_ADMIN:
        can(Action.Manage, 'Student', { campusId: user.campusId } as any);
        can(Action.Manage, 'Family');
        can(Action.Manage, 'Fee', { campusId: user.campusId } as any);
        can(Action.Manage, 'Challan', { campusId: user.campusId } as any);
        can(Action.Manage, 'ClassFeeSchedule');
        can(Action.Manage, 'StudentFee');
        can(Action.Manage, 'Class');
        can(Action.Manage, 'Section');
        can(Action.Read, 'User', { campusId: user.campusId } as any);
        cannot(Action.Delete, 'Campus');
        break;

      case StaffRole.PRINCIPAL:
        can(Action.Read, 'Student', { campusId: user.campusId } as any);
        can(Action.Read, 'Family');
        can(Action.Read, 'Fee', { campusId: user.campusId } as any);
        can(Action.Read, 'Challan', { campusId: user.campusId } as any);
        can(Action.Read, 'ClassFeeSchedule');
        can(Action.Read, 'StudentFee');
        can(Action.Read, 'Class');
        can(Action.Read, 'Section');
        break;

      case StaffRole.FINANCE_CLERK:
        can(Action.Read, 'Student', { campusId: user.campusId } as any);
        can(Action.Manage, 'Fee', { campusId: user.campusId } as any);
        can(Action.Manage, 'Challan', { campusId: user.campusId } as any);
        can(Action.Manage, 'ClassFeeSchedule');
        can(Action.Manage, 'StudentFee');
        can(Action.Read, 'Class');
        can(Action.Read, 'Section');
        break;

      case StaffRole.RECEPTIONIST:
        can(Action.Manage, 'Student', { campusId: user.campusId } as any);
        can(Action.Manage, 'Family');
        can(Action.Manage, 'Class');
        can(Action.Manage, 'Section');
        break;

      case StaffRole.TEACHER:
        can(Action.Read, 'Student', { campusId: user.campusId } as any);
        can(Action.Read, 'Class');
        can(Action.Read, 'Section');
        break;

      case StaffRole.STAFF_EDITOR:
        // Restricted access primarily for staff editing students
        can(Action.Manage, 'Student', { campusId: user.campusId } as any);
        can(Action.Manage, 'Class');
        can(Action.Manage, 'Section');
        can(Action.Manage, 'Family');
        can(Action.Read, 'User', { campusId: user.campusId } as any);
        break;
    }

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
