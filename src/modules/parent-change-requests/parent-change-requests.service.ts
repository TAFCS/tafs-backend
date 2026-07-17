import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateChangeRequestDto } from './dto/create-change-request.dto';
import { ProcessChangeRequestDto, ChangeRequestStatus } from './dto/process-change-request.dto';
import { Prisma } from '@prisma/client';
import { AuthService } from '../auth/auth.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';

export const ACCOUNT_DELETION_REQUEST_TYPE = 'ACCOUNT_DELETION';
const AUDIT_ENTITY_TYPE = 'PARENT_CHANGE_REQUEST';

type FieldDiff = { field: string; old_value: string | null; new_value: string | null; student_id?: number | null };

@Injectable()
export class ParentChangeRequestsService {
  constructor(
    private prisma: PrismaService,
    @Inject(forwardRef(() => AuthService))
    private readonly authService: AuthService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  /**
   * Diffs `requested_data` against the current guardian/student record so both the
   * "requested" and "processed" audit events carry the exact old -> new values, not
   * just the raw JSON blob.
   */
  private async buildFieldDiffs(
    requestedData: Record<string, unknown>,
    guardianId: number,
  ): Promise<FieldDiff[]> {
    if (requestedData?.request_type === ACCOUNT_DELETION_REQUEST_TYPE) {
      return [];
    }

    if (requestedData?.request_type === 'STUDENT_UPDATE') {
      const studentCc = Number(requestedData.student_cc);
      const changes = (requestedData.changes as Record<string, any>) || {};
      const student = await this.prisma.students.findUnique({ where: { cc: studentCc } });
      return Object.entries(changes).map(([field, newValue]) => ({
        field: `student.${field}`,
        old_value: student ? this.stringifyValue((student as any)[field]) : null,
        new_value: this.stringifyValue(newValue),
        student_id: studentCc,
      }));
    }

    const guardian = await this.prisma.guardians.findUnique({ where: { id: guardianId } });
    return Object.entries(requestedData || {}).map(([field, newValue]) => ({
      field: `guardian.${field}`,
      old_value: guardian ? this.stringifyValue((guardian as any)[field]) : null,
      new_value: this.stringifyValue(newValue),
    }));
  }

  private stringifyValue(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value.toISOString();
    return String(value);
  }

  async createAccountDeletionRequestForFamily(familyId: number, reason?: string) {
    const familyGuardianLinks = await this.prisma.student_guardians.findMany({
      where: {
        students: { family_id: familyId },
      },
      include: { guardians: true },
      orderBy: { guardian_id: 'asc' },
    });

    if (familyGuardianLinks.length === 0) {
      throw new NotFoundException('Guardian not found for this family');
    }

    const primaryLink =
      familyGuardianLinks.find((link) => link.is_primary_contact) ??
      familyGuardianLinks[0];
    const guardian = primaryLink.guardians;

    const pending = await this.prisma.parent_change_requests.findFirst({
      where: {
        family_id: familyId,
        status: 'PENDING',
      },
      orderBy: { created_at: 'desc' },
    });

    if (
      pending &&
      (pending.requested_data as Record<string, unknown>)?.request_type ===
        ACCOUNT_DELETION_REQUEST_TYPE
    ) {
      throw new BadRequestException(
        'An account deletion request is already pending admin review',
      );
    }

    return this.createRequest({
      guardian_id: guardian.id,
      family_id: familyId,
      requested_data: {
        request_type: ACCOUNT_DELETION_REQUEST_TYPE,
        reason: reason?.trim() || null,
      },
    });
  }

  async createRequest(dto: CreateChangeRequestDto) {
    // Check if guardian and family exist
    const guardian = await this.prisma.guardians.findUnique({ where: { id: dto.guardian_id } });
    if (!guardian) throw new NotFoundException('Guardian not found');

    const family = await this.prisma.families.findUnique({ where: { id: dto.family_id } });
    if (!family) throw new NotFoundException('Family not found');

    const request = await this.prisma.parent_change_requests.create({
      data: {
        guardian_id: dto.guardian_id,
        family_id: dto.family_id,
        requested_data: dto.requested_data as any,
        status: 'PENDING',
      },
    });

    const actorLabel = guardian.full_name
      ? `${guardian.full_name} (Guardian #${guardian.id}, Family ${family.household_name ?? family.id})`
      : `Guardian #${guardian.id} (Family ${family.household_name ?? family.id})`;

    const diffs = await this.buildFieldDiffs(dto.requested_data, dto.guardian_id);
    const contextNote = `Change request #${request.id} submitted by ${actorLabel} for Family #${dto.family_id}.` +
      (diffs.length === 0
        ? dto.requested_data?.request_type === ACCOUNT_DELETION_REQUEST_TYPE
          ? ` Requesting account deletion. Reason: ${(dto.requested_data as any).reason || 'not provided'}.`
          : ''
        : '');

    if (diffs.length === 0) {
      await this.auditLogs.log({
        entity_type: AUDIT_ENTITY_TYPE,
        entity_id: String(request.id),
        action: 'REQUESTED',
        changed_by: actorLabel,
        note: contextNote,
      });
    } else {
      for (const diff of diffs) {
        await this.auditLogs.log({
          entity_type: AUDIT_ENTITY_TYPE,
          entity_id: String(request.id),
          action: 'REQUESTED',
          field: diff.field,
          old_value: diff.old_value,
          new_value: diff.new_value,
          changed_by: actorLabel,
          student_id: diff.student_id ?? null,
          note: contextNote,
        });
      }
    }

    return request;
  }

  async listRequests() {
    return this.prisma.parent_change_requests.findMany({
      include: {
        guardians: {
          select: {
            full_name: true,
            primary_phone: true,
            email_address: true,
            cnic: true,
            occupation: true,
            job_position: true,
            organization: true,
            education_level: true,
            mailing_address: true,
          },
        },
        families: {
          select: {
            household_name: true,
            students: true,
          },
        },
        processor: {
          select: {
            full_name: true,
          },
        },
      },
      orderBy: { created_at: 'desc' },
    });
  }

  async getRequestById(id: number) {
    const request = await this.prisma.parent_change_requests.findUnique({
      where: { id },
      include: {
        guardians: true,
        families: {
          include: {
            students: true,
          },
        },
      },
    });
    if (!request) throw new NotFoundException('Change request not found');
    return request;
  }

  async processRequest(
    id: number,
    dto: ProcessChangeRequestDto,
    adminId: string,
    adminLabel?: string,
  ) {
    const request = await this.getRequestById(id);

    if (request.status !== 'PENDING') {
      throw new BadRequestException('Request has already been processed');
    }

    // Diff against current data BEFORE the mutation below is applied, so
    // the audit trail reflects what actually changed as a result of this decision.
    const requestedData = request.requested_data as Record<string, unknown>;
    const diffs = await this.buildFieldDiffs(requestedData, request.guardian_id);
    const actorLabel = adminLabel || adminId;
    const contextNote =
      `Change request #${id} for Family #${request.family_id} (Guardian: ${request.guardians.full_name ?? request.guardian_id}) ` +
      `${dto.status.toLowerCase()} by ${actorLabel}.` +
      (dto.comment ? ` Comment: ${dto.comment}` : '') +
      (diffs.length === 0 && requestedData?.request_type === ACCOUNT_DELETION_REQUEST_TYPE
        ? ` Account deletion request. Reason: ${(requestedData as any).reason || 'not provided'}.`
        : '');

    const logProcessedDiffs = async () => {
      if (diffs.length === 0) {
        await this.auditLogs.log({
          entity_type: AUDIT_ENTITY_TYPE,
          entity_id: String(id),
          action: dto.status,
          changed_by: actorLabel,
          note: contextNote,
        });
        return;
      }
      for (const diff of diffs) {
        await this.auditLogs.log({
          entity_type: AUDIT_ENTITY_TYPE,
          entity_id: String(id),
          action: dto.status,
          field: diff.field,
          old_value: diff.old_value,
          new_value: diff.new_value,
          changed_by: actorLabel,
          student_id: diff.student_id ?? null,
          note: contextNote,
        });
      }
    };

    const result = await this.prisma.$transaction(async (tx) => {
      const updatedRequest = await tx.parent_change_requests.update({
        where: { id },
        data: {
          status: dto.status,
          comment: dto.comment,
          processed_by: adminId,
          processed_at: new Date(),
        },
      });

      if (dto.status === ChangeRequestStatus.APPROVED) {
        const requestedData = request.requested_data as Record<string, unknown>;
        const isAccountDeletion =
          requestedData?.request_type === ACCOUNT_DELETION_REQUEST_TYPE;
        if (isAccountDeletion) {
          await this.authService.deleteParentAccount(request.family_id);
        } else if (requestedData?.request_type === 'STUDENT_UPDATE') {
          const studentCc = Number(requestedData.student_cc);
          const changes = requestedData.changes as Record<string, any>;
          // Parse date if dob is present
          if (changes.dob) {
            changes.dob = new Date(changes.dob);
          }
          await tx.students.update({
            where: { cc: studentCc },
            data: changes,
          });
        } else {
          await tx.guardians.update({
            where: { id: request.guardian_id },
            data: request.requested_data as Prisma.InputJsonValue,
          });
        }
      }

      return updatedRequest;
    });

    await logProcessedDiffs();

    return result;
  }
}
