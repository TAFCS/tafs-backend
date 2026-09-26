import 'reflect-metadata';

// @react-pdf/renderer ships ESM that jest does not transform; nothing here
// renders a PDF, so stub it (and the component that imports it).
jest.mock('@react-pdf/renderer', () => ({ renderToBuffer: jest.fn() }));
jest.mock('uuid', () => ({ v4: () => 'mock-uuid' }));
// virtual: jest here has no tsx in moduleFileExtensions, so it cannot resolve the file.
jest.mock('../unconfirmed-admissions/DepositSlipPDF', () => ({ DepositSlipPDF: () => null }), { virtual: true });
jest.mock('../transfers/TransferOrderPDF', () => ({ TransferOrderPDF: () => null }), { virtual: true });
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import { TransferController } from '../transfers/transfer.controller';
import { TransferService } from '../transfers/transfer.service';
import { UnconfirmedAdmissionsController } from '../unconfirmed-admissions/unconfirmed-admissions.controller';
import { UnconfirmedAdmissionsService } from '../unconfirmed-admissions/unconfirmed-admissions.service';
import { IdentityController } from '../identity/identity.controller';
import { IdentityService } from '../identity/identity.service';
import { CampusesController } from '../campuses/campuses.controller';
import { EnrollmentController } from '../enrollments/enrollment.controller';
import { EnrollmentService } from '../enrollments/enrollment.service';
import { HouseBalancerController } from '../house-balancer/house-balancer.controller';
import { HouseBalancerService } from '../house-balancer/house-balancer.service';
import { StudentsController } from '../students/students.controller';
import { FamiliesController } from '../families/families.controller';
import { FamiliesService } from '../families/families.service';
import { ParentChangeRequestsController } from '../parent-change-requests/parent-change-requests.controller';
import { ParentChangeRequestsService } from '../parent-change-requests/parent-change-requests.service';
import { ChangeRequestStatus } from '../parent-change-requests/dto/process-change-request.dto';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { TILES_MANIFEST, actionKey, actionsCover } from './tiles.manifest';
import { computeEffectiveAccess, type EffectiveTile } from './access.effective';
import {
  REQUIRE_ACTION_KEY,
  type RequireActionMetadata,
} from '../../decorators/require-action.decorator';

const tile = (id: string) => TILES_MANIFEST.find((t) => t.id === id)!;

const effectiveTiles: EffectiveTile[] = TILES_MANIFEST.map((t) => ({
  id: t.id,
  capabilities: t.capabilities,
  actions: t.actions?.map((a) => ({ id: a.id, default: !!a.default, implies: a.implies ?? [] })),
  legacyFullAccessCapabilities: t.legacyFullAccessCapabilities,
}));
const base = {
  allPermissionKeys: [...new Set(TILES_MANIFEST.flatMap((t) => t.capabilities))],
  activeTiles: effectiveTiles,
  packTileIds: [] as string[],
  allowTileIds: [] as string[],
  denyTileIds: [] as string[],
  userPerms: [] as { key: string; granted: boolean }[],
};

function meta(target: object, handler?: string): RequireActionMetadata | undefined {
  return Reflect.getMetadata(REQUIRE_ACTION_KEY, handler ? (target as any)[handler] : (target as any));
}

function keysExist(keys: string[]) {
  for (const key of keys) {
    const [tileId, actionId] = key.split('#');
    expect({ key, ok: !!tile(tileId)?.actions?.some((a) => a.id === actionId) }).toEqual({ key, ok: true });
  }
}

const scopedUser = { sub: 'u', role: 'EMPLOYEE', campusId: null, allowedClassIds: [] } as any;

describe('Transfers', () => {
  const t = tile('student.transfers');

  it('is bridged from academic.transfers.execute, so a view-only role loses only the transfer', () => {
    expect(t.legacyFullAccessCapabilities).toEqual(['academic.transfers.execute']);
    const viewOnly = computeEffectiveAccess({
      ...base,
      role: StaffRole.PRINCIPAL,
      roleKeys: ['academic.transfers.view'],
    });
    const held = viewOnly.actionIds.filter((k) => k.startsWith('student.transfers#'));
    expect(held).toEqual([actionKey('student.transfers', 'view')]);

    const executor = computeEffectiveAccess({
      ...base,
      role: StaffRole.CAMPUS_ADMIN,
      roleKeys: ['academic.transfers.view', 'academic.transfers.execute'],
    });
    for (const a of t.actions!) expect(executor.actionIds).toContain(actionKey('student.transfers', a.id));
  });

  // Regression: this controller once had no @UseGuards at all, which left
  // POST /transfers/:cc/execute open to anyone without a login.
  it('is authenticated and action-gated at the class level', () => {
    const guards: unknown[] = Reflect.getMetadata('__guards__', TransferController) ?? [];
    expect(guards).toContain(JwtStaffGuard);
    expect(guards).toContain(TileActionGuard);
    expect(meta(TransferController)?.actionKeys).toEqual([actionKey('student.transfers', 'view')]);
  });

  it('puts the transfer and the PDF/order routes on their own actions', () => {
    const proto = TransferController.prototype;
    expect(meta(proto, 'executeTransfer')?.actionKeys).toEqual([actionKey('student.transfers', 'execute')]);
    expect(meta(proto, 'generatePdf')?.actionKeys).toEqual([actionKey('student.transfers', 'print')]);
    // Shared with the Student Directory's Transfer Order tab.
    expect(meta(proto, 'getTransferOrder')?.mode).toBe('any');
    expect(meta(proto, 'getTransferOrder')?.actionKeys).toEqual([
      actionKey('student.transfers', 'print'),
      actionKey('student.directory', 'view'),
    ]);
    keysExist(['student.transfers#view', 'student.transfers#execute', 'student.transfers#print', 'student.directory#view']);
  });

  function service(opts: { student?: unknown; canSee?: boolean; scopeThrows?: boolean }) {
    const prisma = {
      students: {
        findUnique: jest.fn().mockResolvedValue(opts.student ?? null),
        findFirst: jest.fn().mockResolvedValue(opts.student ? { cc: 1 } : null),
      },
      classes: { findUnique: jest.fn().mockResolvedValue({ description: 'X', academic_system: 'S', segment_id: 1 }) },
      campuses: { findUnique: jest.fn().mockResolvedValue({ id: 2 }) },
    };
    const scope = {
      canSeeStudent: jest.fn().mockReturnValue(opts.canSee ?? true),
      whereForStudents: jest.fn().mockReturnValue({}),
      assertCampus: jest.fn(() => {
        if (opts.scopeThrows) throw new ForbiddenException('nope');
      }),
      assertClass: jest.fn(),
      assertSegment: jest.fn(),
      assertSection: jest.fn(),
    };
    const svc = new TransferService(prisma as any, {} as any, { log: jest.fn() } as any, {} as any, {} as any, scope as any);
    return { svc, prisma, scope };
  }

  const student = { campus_id: 1, class_id: 3, section_id: 4, classes: { segment_id: 1 }, deleted_at: null };

  it('404s a student outside the caller scope on every read and on execute', async () => {
    const { svc } = service({ student, canSee: false });
    await expect(svc.getAvailableClasses(1, scopedUser)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.previewTransferGr(1, 2, undefined, scopedUser)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.getTransferOrderData(1, scopedUser)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.executeTransfer(1, { to_class_id: 9 }, 'x', scopedUser)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a transfer INTO a campus the caller cannot act on, before any write', async () => {
    const { svc, prisma } = service({ student, canSee: true, scopeThrows: true });
    await expect(
      svc.executeTransfer(1, { to_class_id: 9, to_campus_id: 2 }, 'x', scopedUser),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect((prisma as any).$transaction).toBeUndefined(); // never reached
  });
});

describe('House Balancer (two tiles, one page)', () => {
  const a = tile('student.house_balancer');
  const b = tile('school-setup.house_balancer');

  it('gives both tile ids the same actions and the same bridge', () => {
    expect(a.actions).toBe(b.actions);
    expect(a.legacyFullAccessCapabilities).toEqual(['academic.campuses.edit']);
    expect(b.legacyFullAccessCapabilities).toEqual(['academic.campuses.edit']);
  });

  it('accepts either tile on every route, with preview/apply on their own actions', () => {
    const cls = meta(HouseBalancerController);
    expect(cls?.mode).toBe('any');
    expect(cls?.actionKeys).toEqual(['student.house_balancer#view', 'school-setup.house_balancer#view']);
    const p = HouseBalancerController.prototype;
    for (const h of ['preview', 'previewCampus']) {
      expect(meta(p, h)?.actionKeys).toEqual(['student.house_balancer#preview', 'school-setup.house_balancer#preview']);
    }
    for (const h of ['apply', 'applyCampus']) {
      expect(meta(p, h)?.actionKeys).toEqual(['student.house_balancer#apply', 'school-setup.house_balancer#apply']);
    }
    keysExist(cls!.actionKeys);
  });

  function svc(opts: { campusThrows?: boolean }) {
    const scope = {
      assertCampus: jest.fn(() => {
        if (opts.campusThrows) throw new ForbiddenException('nope');
      }),
      assertClass: jest.fn(),
      assertSection: jest.fn(),
      scopeOf: jest.fn().mockReturnValue({ campuses: [7] }),
    };
    const prisma = { campuses: { findUnique: jest.fn() }, audit_logs: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn() } };
    const s = new HouseBalancerService(prisma as any, {} as any, {} as any, scope as any);
    return { s, scope, prisma };
  }

  it('refuses every operation on a campus outside scope before touching data', async () => {
    const { s, prisma } = svc({ campusThrows: true });
    const dto = { campus_id: 5, class_id: 1, section_id: 1 } as any;
    await expect(s.preview(dto, scopedUser)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(s.apply({ ...dto, assignments: [], roster_fingerprint: 'x' } as any, 'x', scopedUser)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(s.previewCampus({ campus_id: 5 } as any, scopedUser)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(s.applyCampus({ campus_id: 5, groups: [] } as any, 'x', scopedUser)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(s.listHistory(5, 20, 0, scopedUser)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.campuses.findUnique).not.toHaveBeenCalled();
  });

  it('404s a history row from an out-of-scope campus, and one it cannot tie to a campus', async () => {
    const row = (entity_id: string) => ({ id: 1, action: 'HOUSE_REBALANCE', entity_type: 'HOUSE', entity_id, new_value: null });
    const { s, prisma } = svc({ campusThrows: true });
    prisma.audit_logs.findUnique.mockResolvedValue(row('5:1:1'));
    await expect(s.getHistory(1, scopedUser)).rejects.toBeInstanceOf(NotFoundException);
    prisma.audit_logs.findUnique.mockResolvedValue(row('weird'));
    await expect(s.getHistory(1, scopedUser)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('Academic Actions', () => {
  it('lets a holder of only this tile reach the bulk-promote and GR-suggestion routes', () => {
    const p = StudentsController.prototype;
    for (const h of ['promoteBulk']) {
      expect(meta(p, h)?.actionKeys).toContain('student.academic_actions#promote');
      expect(meta(p, h)?.actionKeys).toContain('student.directory#promote');
    }
    // single-student promotion stays with the Student Directory
    expect(meta(p, 'promoteSingle')?.actionKeys).toEqual(['student.directory#promote']);
    keysExist(['student.academic_actions#promote']);
  });

  it('is bridged from its own opening capability', () => {
    expect(tile('student.academic_actions').legacyFullAccessCapabilities).toEqual(['academic.bulk_promote.execute']);
  });
});

describe('Enrollments', () => {
  const t = tile('student.enrollments');

  it('is bridged from students.enrollment.complete, so a view-only role loses only the writes', () => {
    expect(t.legacyFullAccessCapabilities).toEqual(['students.enrollment.complete']);
    const viewOnly = computeEffectiveAccess({
      ...base,
      role: StaffRole.PRINCIPAL,
      roleKeys: ['students.enrollment.view'],
    });
    expect(viewOnly.actionIds.filter((k) => k.startsWith('student.enrollments#'))).toEqual([
      actionKey('student.enrollments', 'view'),
    ]);
    const admin = computeEffectiveAccess({
      ...base,
      role: StaffRole.CAMPUS_ADMIN,
      roleKeys: ['students.enrollment.view', 'students.enrollment.complete'],
    });
    for (const a of t.actions!) expect(admin.actionIds).toContain(actionKey('student.enrollments', a.id));
  });

  it('puts the writes on their own actions and the page-only reads on view', () => {
    const p = EnrollmentController.prototype;
    expect(meta(p, 'enroll')?.actionKeys).toEqual([actionKey('student.enrollments', 'enroll')]);
    expect(meta(p, 'updatePursuitStatus')?.actionKeys).toEqual([actionKey('student.enrollments', 'pursuit_status')]);
    expect(meta(p, 'getCandidates')?.actionKeys).toEqual([actionKey('student.enrollments', 'view')]);
    expect(meta(p, 'getSuggestions')?.actionKeys).toEqual([actionKey('student.enrollments', 'view')]);
    keysExist(['student.enrollments#view', 'student.enrollments#enroll', 'student.enrollments#pursuit_status']);
    const guards: unknown[] = Reflect.getMetadata('__guards__', EnrollmentController) ?? [];
    expect(guards).toContain(TileActionGuard);
  });

  // Certificates / admission order / houses are shared with Student Directory
  // tabs and the Register page: pinning them to this tile would lock those out.
  it.each(['getAdmissionOrder', 'getLeavingCertificate', 'getLeavingCertificatePdf', 'logCertificateGeneration', 'getCertificateHistory', 'getHouses'])(
    'leaves the shared route %s without a tile action',
    (h) => expect(meta(EnrollmentController.prototype, h)).toBeUndefined(),
  );

  function svc(opts: { student?: unknown; canSee?: boolean; sectionThrows?: boolean }) {
    const prisma = {
      students: {
        findUnique: jest.fn().mockResolvedValue(opts.student ?? null),
        findFirst: jest.fn().mockResolvedValue(opts.student ? { cc: 1 } : null),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
      },
      audit_logs: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const scope = {
      canSeeStudent: jest.fn().mockReturnValue(opts.canSee ?? true),
      whereForStudents: jest.fn().mockReturnValue({ campus_id: { in: [3] } }),
      assertSection: jest.fn(() => {
        if (opts.sectionThrows) throw new ForbiddenException('nope');
      }),
      assertClass: jest.fn(),
    };
    const s = new EnrollmentService(prisma as any, {} as any, { log: jest.fn() } as any, {} as any, scope as any);
    return { s, prisma, scope };
  }
  const stu = { campus_id: 1, class_id: 3, section_id: 4, classes: { segment_id: 1 }, status: 'SOFT_ADMISSION' };

  it('narrows the candidate list to the caller scope', async () => {
    const { s, prisma } = svc({});
    await s.getCandidates(scopedUser);
    const where = prisma.students.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('SOFT_ADMISSION');
    expect(JSON.stringify(where.AND)).toContain('"campus_id":{"in":[3]}');
  });

  it('404s an out-of-scope student on every cc route, before any write', async () => {
    const { s, prisma } = svc({ student: stu, canSee: false });
    await expect(s.getSuggestions(1, undefined, undefined, scopedUser)).rejects.toBeInstanceOf(NotFoundException);
    await expect(s.enroll(1, { gr_number: 'x', house_id: 1 } as any, 'u', scopedUser)).rejects.toBeInstanceOf(NotFoundException);
    await expect(s.updatePursuitStatus(1, true, 'u', scopedUser)).rejects.toBeInstanceOf(NotFoundException);
    await expect(s.getAdmissionOrderData(1, scopedUser)).rejects.toBeInstanceOf(NotFoundException);
    await expect(s.getLeavingCertificateData(1, 'u', scopedUser)).rejects.toBeInstanceOf(NotFoundException);
    await expect(s.getCertificateHistory(1, scopedUser)).rejects.toBeInstanceOf(NotFoundException);
    await expect(s.logCertificateGeneration(1, 'SLC', undefined, undefined, 'u', scopedUser)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.students.update).not.toHaveBeenCalled();
  });

  it('refuses enrolling into a section outside scope', async () => {
    const { s } = svc({ student: stu, canSee: true, sectionThrows: true });
    await expect(
      s.enroll(1, { gr_number: 'x', house_id: 1, section_id: 9 } as any, 'u', scopedUser),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('Families', () => {
  const t = tile('student.families');

  it('is bridged from students.families.edit, so a view-only role loses only writes/mutations', () => {
    expect(t.legacyFullAccessCapabilities).toEqual(['students.families.edit']);
    const viewOnly = computeEffectiveAccess({
      ...base,
      role: StaffRole.PRINCIPAL,
      roleKeys: ['students.families.view'],
    });
    expect(viewOnly.actionIds.filter((k) => k.startsWith('student.families#'))).toEqual([
      actionKey('student.families', 'view'),
    ]);
    const admin = computeEffectiveAccess({
      ...base,
      role: StaffRole.CAMPUS_ADMIN,
      roleKeys: ['students.families.view', 'students.families.edit'],
    });
    for (const a of t.actions!) expect(admin.actionIds).toContain(actionKey('student.families', a.id));
  });

  it('puts mutations on their own actions and lists/reads on view', () => {
    const p = FamiliesController.prototype;
    expect(meta(p, 'listFamilies')?.actionKeys).toEqual([actionKey('student.families', 'view')]);
    expect(meta(p, 'getFamilyStats')?.actionKeys).toEqual([actionKey('student.families', 'view')]);
    expect(meta(p, 'getFamilyById')?.actionKeys).toEqual([actionKey('student.families', 'view')]);
    expect(meta(p, 'createFamily')?.actionKeys).toEqual([actionKey('student.families', 'create')]);
    expect(meta(p, 'initializeFromStudent')?.actionKeys).toEqual([actionKey('student.families', 'create')]);
    expect(meta(p, 'updateFamily')?.actionKeys).toEqual([actionKey('student.families', 'edit')]);
    expect(meta(p, 'assignChild')?.actionKeys).toEqual([actionKey('student.families', 'assign_student')]);
    expect(meta(p, 'removeChild')?.actionKeys).toEqual([actionKey('student.families', 'assign_student')]);
    keysExist([
      'student.families#view',
      'student.families#create',
      'student.families#edit',
      'student.families#assign_student',
    ]);
    const guards: unknown[] = Reflect.getMetadata('__guards__', FamiliesController) ?? [];
    expect(guards).toContain(TileActionGuard);
  });

  function svc(opts: { family?: unknown; student?: unknown; canSee?: boolean }) {
    const prisma = {
      families: {
        findFirst: jest.fn().mockResolvedValue(opts.family ?? null),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({ id: 1, household_name: 'Test Fam' }),
        update: jest.fn().mockResolvedValue({ id: 1, household_name: 'Updated Fam' }),
      },
      students: {
        findFirst: jest.fn().mockResolvedValue(opts.student ?? null),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn(),
      },
      student_guardians: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      audit_logs: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn((cb) => (typeof cb === 'function' ? cb(prisma) : Promise.all(cb))),
    };
    const scope = {
      isExempt: jest.fn().mockReturnValue(false),
      canSeeStudent: jest.fn().mockReturnValue(opts.canSee ?? true),
      whereForStudents: jest.fn().mockReturnValue({ campus_id: { in: [3] } }),
    };
    const auditLogs = { log: jest.fn() };
    const s = new FamiliesService(prisma as any, auditLogs as any, scope as any);
    return { s, prisma, scope };
  }

  const famWithStudent = {
    id: 1,
    household_name: 'Test Fam',
    students: [{ cc: 1, campus_id: 1, class_id: 3, section_id: 4, classes: { segment_id: 1 } }],
  };

  it('narrows listFamilies and getFamilyStats to caller student scope', async () => {
    const { s, prisma } = svc({});
    await s.listFamilies({ page: 1, limit: 10 }, scopedUser);
    const findWhere = prisma.families.findMany.mock.calls[0][0].where;
    expect(JSON.stringify(findWhere.students.some)).toContain('"campus_id":{"in":[3]}');

    await s.getFamilyStats(scopedUser);
    const countWhere = prisma.families.count.mock.calls[0][0].where;
    expect(JSON.stringify(countWhere.students.some)).toContain('"campus_id":{"in":[3]}');
  });

  it('404s an out-of-scope family on getFamilyById and updateFamily', async () => {
    const { s } = svc({ family: famWithStudent, canSee: false });
    await expect(s.getFamilyById(1, scopedUser)).rejects.toBeInstanceOf(NotFoundException);
    await expect(s.updateFamily(1, { household_name: 'New' }, scopedUser)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s out-of-scope assignments and student initializations', async () => {
    const { s } = svc({
      family: famWithStudent,
      student: { cc: 2, campus_id: 2, class_id: 1, section_id: 1 },
      canSee: false,
    });
    await expect(s.assignChildToFamily(1, 2, scopedUser)).rejects.toBeInstanceOf(NotFoundException);
    await expect(s.initializeFamilyFromStudent(2, scopedUser)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('Parent Change Requests', () => {
  const t = tile('student.parent_change_requests');

  it('is bridged from students.families.edit, so a view-only role gets view and an editor gets process', () => {
    expect(t.legacyFullAccessCapabilities).toEqual(['students.families.edit']);
    const viewOnly = computeEffectiveAccess({
      ...base,
      role: StaffRole.PRINCIPAL,
      roleKeys: ['students.families.view'],
    });
    const held = viewOnly.actionIds.filter((k) => k.startsWith('student.parent_change_requests#'));
    expect(held).toEqual([actionKey('student.parent_change_requests', 'view')]);

    const editor = computeEffectiveAccess({
      ...base,
      role: StaffRole.CAMPUS_ADMIN,
      roleKeys: ['students.families.view', 'students.families.edit'],
    });
    for (const a of t.actions!) {
      expect(editor.actionIds).toContain(actionKey('student.parent_change_requests', a.id));
    }
  });

  it('decorates routes with tile actions', () => {
    const proto = ParentChangeRequestsController.prototype;
    expect(meta(proto, 'listRequests')?.actionKeys).toEqual([
      actionKey('student.parent_change_requests', 'view'),
    ]);
    expect(meta(proto, 'getRequest')?.actionKeys).toEqual([
      actionKey('student.parent_change_requests', 'view'),
    ]);
    expect(meta(proto, 'processRequest')?.actionKeys).toEqual([
      actionKey('student.parent_change_requests', 'process'),
    ]);
    keysExist([
      'student.parent_change_requests#view',
      'student.parent_change_requests#process',
    ]);
  });

  function svc(opts: { request?: unknown; canSee?: boolean }) {
    const prisma = {
      parent_change_requests: {
        findUnique: jest.fn().mockResolvedValue(opts.request ?? null),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({ id: 2 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 1, status: 'APPROVED' }),
      },
      guardians: {
        findUnique: jest.fn().mockResolvedValue({ id: 1, full_name: 'Parent' }),
        update: jest.fn().mockResolvedValue({}),
      },
      families: {
        findUnique: jest.fn().mockResolvedValue({ id: 1, household_name: 'Family' }),
        update: jest.fn().mockResolvedValue({}),
      },
      students: {
        findUnique: jest.fn().mockResolvedValue({ cc: 1 }),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
      },
      student_guardians: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      audit_logs: { log: jest.fn() },
      $transaction: jest.fn((cb) => (typeof cb === 'function' ? cb(prisma) : Promise.all(cb))),
    };
    const scope = {
      isExempt: jest.fn().mockReturnValue(false),
      canSeeStudent: jest.fn().mockReturnValue(opts.canSee ?? true),
      whereForStudents: jest.fn().mockReturnValue({ campus_id: { in: [3] } }),
    };
    const authService = { deleteParentAccount: jest.fn() };
    const auditLogs = { log: jest.fn() };
    const noticeBoard = { createPost: jest.fn() };
    const s = new ParentChangeRequestsService(
      prisma as any,
      authService as any,
      auditLogs as any,
      noticeBoard as any,
      scope as any,
    );
    return { s, prisma, scope };
  }

  const reqWithStudent = {
    id: 1,
    guardian_id: 1,
    family_id: 1,
    status: 'PENDING',
    requested_data: { full_name: 'NEW NAME' },
    guardians: { id: 1, full_name: 'Old Name' },
    families: {
      id: 1,
      household_name: 'Family',
      students: [{ cc: 1, campus_id: 1, class_id: 3, section_id: 4, classes: { segment_id: 1 } }],
    },
  };

  it('narrows listRequests to caller student scope', async () => {
    const { s, prisma } = svc({});
    await s.listRequests(scopedUser);
    const findWhere = prisma.parent_change_requests.findMany.mock.calls[0][0].where;
    expect(JSON.stringify(findWhere.families.students.some)).toContain('"campus_id":{"in":[3]}');
  });

  it('404s an out-of-scope change request on getRequestById and processRequest', async () => {
    const { s } = svc({ request: reqWithStudent, canSee: false });
    await expect(s.getRequestById(1, scopedUser)).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      s.processRequest(1, { status: ChangeRequestStatus.APPROVED }, 'admin', 'admin', scopedUser),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});


describe('Quick Registration', () => {
  const t = tile('student.quick_registration');

  it('has NO legacy bridge: nobody but SUPER_ADMIN could do this before, so nobody inherits it', () => {
    expect(t.legacyFullAccessCapabilities).toBeUndefined();
    expect(t.actions!.filter((a) => a.default).map((a) => a.id)).toEqual(['view']);
  });

  it('shows the tile to a registration.view holder but grants no write action', () => {
    const r = computeEffectiveAccess({ ...base, role: StaffRole.EMPLOYEE, roleKeys: ['students.registration.view', 'students.registration.create'] });
    expect(r.tileIds).toContain('student.quick_registration');
    expect(r.actionIds.filter((k) => k.startsWith('student.quick_registration#'))).toEqual([
      actionKey('student.quick_registration', 'view'),
    ]);
  });

  it('lets a SUPER_ADMIN delegate: a granted `create` is held', () => {
    const r = computeEffectiveAccess({
      ...base,
      role: StaffRole.EMPLOYEE,
      allowTileIds: ['student.quick_registration'],
      userActionGrants: [{ tileId: 'student.quick_registration', actionId: 'create', allow: true }],
    });
    expect(r.actionIds).toContain(actionKey('student.quick_registration', 'create'));
  });

  it('gates create, read-back and both photo uploads on `create`, and leaves the shared deposit slip alone', () => {
    const p = UnconfirmedAdmissionsController.prototype;
    for (const h of ['create', 'getByCC', 'uploadPhoto', 'uploadGuardianPhoto']) {
      expect(meta(p, h)?.actionKeys).toEqual([actionKey('student.quick_registration', 'create')]);
    }
    expect(meta(p, 'getDepositSlip')).toBeUndefined();
    const guards: unknown[] = Reflect.getMetadata('__guards__', UnconfirmedAdmissionsController) ?? [];
    expect(guards).toContain(TileActionGuard);
    keysExist(['student.quick_registration#create']);
  });

  it('no longer hard-codes a role check in the controller', () => {
    expect((UnconfirmedAdmissionsController.prototype as any).assertSuperAdmin).toBeUndefined();
  });

  function svc(opts: { student?: unknown; canSee?: boolean; campusThrows?: boolean; leftover?: unknown }) {
    const prisma = {
      students: {
        findUnique: jest.fn().mockResolvedValue(opts.student ?? null),
        findFirst: jest.fn().mockResolvedValue(opts.student ? { cc: 1, status: 'QUICK_ADMISSION' } : null),
      },
      unconfirmed_admissions: { findUnique: jest.fn().mockResolvedValue(opts.leftover ?? null) },
      $transaction: jest.fn(),
    };
    const scope = {
      canSeeStudent: jest.fn().mockReturnValue(opts.canSee ?? true),
      assertCampus: jest.fn(() => {
        if (opts.campusThrows) throw new ForbiddenException('nope');
      }),
    };
    const s = new UnconfirmedAdmissionsService(prisma as any, {} as any, {} as any, { log: jest.fn() } as any, scope as any);
    return { s, prisma, scope };
  }
  const stu = { campus_id: 1, class_id: null, section_id: null, classes: null };

  it('refuses a create whose campus is outside scope, and one with no campus for a restricted caller, before any write', async () => {
    const { s, prisma, scope } = svc({ campusThrows: true });
    await expect(s.create({ campus_id: 9 } as any, 'u', scopedUser)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(s.create({} as any, 'u', scopedUser)).rejects.toBeInstanceOf(ForbiddenException);
    expect(scope.assertCampus).toHaveBeenLastCalledWith(scopedUser, null);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('404s a quick admission outside scope on read, both photo uploads and the deposit slip', async () => {
    const { s } = svc({ student: stu, canSee: false });
    const file = { originalname: 'a.jpg', buffer: Buffer.from('x'), mimetype: 'image/jpeg' } as any;
    await expect(s.getByCC(1, scopedUser)).rejects.toBeInstanceOf(NotFoundException);
    await expect(s.uploadPhoto(1, file, 'u', scopedUser)).rejects.toBeInstanceOf(NotFoundException);
    await expect(s.uploadGuardianPhoto(1, 0, file, 'u', scopedUser)).rejects.toBeInstanceOf(NotFoundException);
    await expect(s.generateDepositSlipPdf(1, scopedUser)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('applies the campus scope to a leftover row from the legacy table too', async () => {
    const { s } = svc({ student: null, canSee: false, leftover: { id: 7, campus_id: 5 } });
    await expect(s.getByCC(7, scopedUser)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('Registration', () => {
  const t = tile('student.registration');

  it('is bridged from every capability that already meant "manage Student"', () => {
    expect(t.legacyFullAccessCapabilities).toEqual([
      'students.registration.create',
      'students.enrollment.complete',
      'students.directory.edit',
    ]);
  });

  it('keeps a registration.view-only role read-only, and every existing manager fully covered', () => {
    const viewOnly = computeEffectiveAccess({ ...base, role: StaffRole.EMPLOYEE, roleKeys: ['students.registration.view'] });
    expect(viewOnly.actionIds.filter((k) => k.startsWith('student.registration#'))).toEqual([
      actionKey('student.registration', 'view'),
    ]);
    for (const cap of t.legacyFullAccessCapabilities!) {
      const r = computeEffectiveAccess({ ...base, role: StaffRole.PRINCIPAL, roleKeys: ['students.registration.view', cap] });
      for (const a of t.actions!) expect(r.actionIds).toContain(actionKey('student.registration', a.id));
    }
  });

  it('gates every route on its own action and keeps the policy check', () => {
    const p = IdentityController.prototype;
    expect(meta(p, 'register')?.actionKeys).toEqual([actionKey('student.registration', 'register')]);
    expect(meta(p, 'submitAdmissionForm')?.actionKeys).toEqual([actionKey('student.registration', 'admission_form')]);
    expect(meta(p, 'getByCC')?.actionKeys).toEqual([actionKey('student.registration', 'view')]);
    expect(meta(p, 'getGuardianByCnic')?.actionKeys).toEqual([actionKey('student.registration', 'view')]);
    keysExist(['student.registration#view', 'student.registration#register', 'student.registration#admission_form']);
    const guards: unknown[] = Reflect.getMetadata('__guards__', IdentityController) ?? [];
    expect(guards).toContain(TileActionGuard);
  });

  function svc(opts: { student?: unknown; canSee?: boolean; campusThrows?: boolean; leftover?: unknown }) {
    const prisma = {
      students: {
        findUnique: jest.fn().mockResolvedValue(opts.student ?? null),
        findFirst: jest.fn().mockResolvedValue(opts.student ? { cc: 1 } : null),
      },
      unconfirmed_admissions: { findUnique: jest.fn().mockResolvedValue(opts.leftover ?? null) },
      $transaction: jest.fn(),
    };
    const scope = {
      canSeeStudent: jest.fn().mockReturnValue(opts.canSee ?? true),
      assertCampus: jest.fn(() => {
        if (opts.campusThrows) throw new ForbiddenException('nope');
      }),
      assertClass: jest.fn(),
      assertSection: jest.fn(),
    };
    const s = new IdentityService(prisma as any, {} as any, {} as any, { log: jest.fn() } as any, scope as any);
    return { s, prisma, scope };
  }
  const stu = { campus_id: 1, class_id: 3, section_id: 4, classes: { segment_id: 1 } };

  it('refuses registering into a campus outside scope, or with no campus for a restricted caller, before any write', async () => {
    const { s, prisma, scope } = svc({ campusThrows: true });
    await expect(s.registerAdmission({ admission: { campus_id: 9 } } as any, 'u', scopedUser)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(s.registerAdmission({ admission: {} } as any, 'u', scopedUser)).rejects.toBeInstanceOf(ForbiddenException);
    expect(scope.assertCampus).toHaveBeenLastCalledWith(scopedUser, null);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('checks the class and section it registers into, and the quick admission it completes', async () => {
    const { s, scope } = svc({ student: stu, canSee: false });
    await expect(
      s.registerAdmission({ admission: { campus_id: 1, class_id: 5, section_id: 6 }, existing_cc: 1 } as any, 'u', scopedUser),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(scope.assertClass).toHaveBeenCalledWith(scopedUser, 5);
    expect(scope.assertSection).toHaveBeenCalledWith(scopedUser, 6);
  });

  it('404s an out-of-scope student on the by-cc lookup and the admission form, and a leftover by campus', async () => {
    const hidden = svc({ student: stu, canSee: false });
    await expect(hidden.s.getAdmissionByCC(1, scopedUser)).rejects.toBeInstanceOf(NotFoundException);
    await expect(hidden.s.submitAdmissionForm({ cc: 1 } as any, scopedUser)).rejects.toBeInstanceOf(NotFoundException);
    expect(hidden.prisma.$transaction).not.toHaveBeenCalled();
    const leftover = svc({ student: null, canSee: false, leftover: { campus_id: 5 } });
    await expect(leftover.s.getAdmissionByCC(7, scopedUser)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('Section Allocation Rules (two tiles, one page)', () => {
  const a = tile('student.section_allocation');
  const b = tile('school-setup.section_allocation');

  it('gives both tile ids the same actions and the same bridge', () => {
    expect(a.actions).toBe(b.actions);
    expect(a.legacyFullAccessCapabilities).toEqual(['academic.campuses.edit']);
    expect(b.legacyFullAccessCapabilities).toEqual(['academic.campuses.edit']);
  });

  it('keeps a campuses.view-only role read-only and gives an editor everything', () => {
    const viewOnly = computeEffectiveAccess({ ...base, role: StaffRole.PRINCIPAL, roleKeys: ['academic.campuses.view'] });
    expect(viewOnly.actionIds.filter((k) => k.includes('section_allocation#'))).toEqual([
      actionKey('student.section_allocation', 'view'),
      actionKey('school-setup.section_allocation', 'view'),
    ]);
    const editor = computeEffectiveAccess({
      ...base,
      role: StaffRole.CAMPUS_ADMIN,
      roleKeys: ['academic.campuses.view', 'academic.campuses.edit'],
    });
    for (const id of ['student.section_allocation', 'school-setup.section_allocation']) {
      for (const act of a.actions!) expect(editor.actionIds).toContain(actionKey(id, act.id));
    }
  });

  it('lets a holder of ONLY this tile reach the roster list, the move route and the section PUT', () => {
    const r = computeEffectiveAccess({
      ...base,
      role: StaffRole.CAMPUS_ADMIN,
      roleKeys: ['academic.campuses.view', 'academic.campuses.edit'],
    });
    const held = new Set(r.actionIds);
    // ...and does NOT hold the Student Directory tile.
    expect(r.tileIds).not.toContain('student.directory');
    for (const [ctrl, handler] of [
      [StudentsController, 'findAll'],
      [StudentsController, 'assignStudent'],
      [CampusesController, 'upsertCampusSection'],
    ] as const) {
      const m = meta(ctrl.prototype, handler)!;
      expect(m.mode).toBe('any');
      expect(m.actionKeys.some((k) => actionsCover(held, k))).toBe(true);
    }
  });

  it('keeps the shared routes open to every tile that already calls them', () => {
    const list = meta(StudentsController.prototype, 'findAll')!.actionKeys;
    expect(list).toEqual(
      expect.arrayContaining([
        'student.directory#view',
        'student.academic_actions#view',
        'student.section_allocation#view',
        'school-setup.section_allocation#view',
      ]),
    );
    expect(meta(StudentsController.prototype, 'assignStudent')!.actionKeys).toEqual(
      expect.arrayContaining(['student.directory#assignment.edit', 'student.section_allocation#move', 'school-setup.section_allocation#move']),
    );
    const put = meta(CampusesController.prototype, 'upsertCampusSection')!.actionKeys;
    expect(put).toEqual(
      expect.arrayContaining([
        'school-setup.campuses#classes.manage', // Campuses page
        'finance.student_overrides#schedule.edit', // Student Overrides saves the section
        'student.section_allocation#rules.edit',
        'school-setup.section_allocation#rules.edit',
      ]),
    );
    keysExist([...list, ...put, 'student.section_allocation#move', 'school-setup.section_allocation#move']);
  });
});
