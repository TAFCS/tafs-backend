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
        can(Action.Manage, 'Class');
        can(Action.Read, 'User', { campusId: user.campusId } as any);
        cannot(Action.Delete, 'Campus');
        break;

      case StaffRole.PRINCIPAL:
        can(Action.Read, 'Student', { campusId: user.campusId } as any);
        can(Action.Read, 'Family');
        can(Action.Read, 'Fee', { campusId: user.campusId } as any);
        can(Action.Read, 'Challan', { campusId: user.campusId } as any);
        can(Action.Read, 'Class');
        break;

      case StaffRole.FINANCE_CLERK:
        can(Action.Read, 'Student', { campusId: user.campusId } as any);
        can(Action.Manage, 'Fee', { campusId: user.campusId } as any);
        can(Action.Manage, 'Challan', { campusId: user.campusId } as any);
        can(Action.Read, 'Class');
        break;

      case StaffRole.RECEPTIONIST:
        can(Action.Manage, 'Student', { campusId: user.campusId } as any);
        can(Action.Manage, 'Family');
        can(Action.Manage, 'Class');
        break;

      case StaffRole.TEACHER:
        can(Action.Read, 'Student', { campusId: user.campusId } as any);
        can(Action.Read, 'Class');
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

    return build();
  }
}
