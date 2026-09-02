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
import { AuthService } from '../auth/auth.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { NoticeBoardService } from '../notice-board/notice-board.service';
import { Prisma } from '@prisma/client';
import { resolveTemplate, isTemplateDisabled } from '../../utils/notification-templates.util';
import { invalidateUnpaidVoucherPdfs, isFatherRelationship } from '../vouchers/invalidate-unpaid-pdfs';

export const ACCOUNT_DELETION_REQUEST_TYPE = 'ACCOUNT_DELETION';
const AUDIT_ENTITY_TYPE = 'PARENT_CHANGE_REQUEST';

/** Max lengths for guardian varchar columns (keep in sync with prisma schema). */
const GUARDIAN_FIELD_MAX_LENGTHS: Record<string, number> = {
  full_name: 100,
  primary_phone: 20,
  primary_phone_country_code: 10,
  whatsapp_number: 20,
  whatsapp_country_code: 10,
  work_phone: 20,
  work_phone_country_code: 10,
  email_address: 100,
  education_level: 255,
  occupation: 100,
  organization: 255,
  job_position: 100,
  house_appt_name: 255,
  house_appt_number: 50,
  area_block: 100,
  country: 50,
  province: 50,
  city: 50,
  postal_code: 20,
  fax_number: 20,
  place_of_birth: 100,
  occupational_position: 100,
};

type FieldDiff = { field: string; old_value: string | null; new_value: string | null; student_id?: number | null };

@Injectable()
export class ParentChangeRequestsService {
  constructor(
    private prisma: PrismaService,
    @Inject(forwardRef(() => AuthService))
    private readonly authService: AuthService,
    private readonly auditLogs: AuditLogsService,
    @Inject(forwardRef(() => NoticeBoardService))
    private readonly noticeBoardService: NoticeBoardService,
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

  /**
   * Renders all field-level diffs for one request as a single "field: old → new; ..."
   * summary so they land in one audit_logs row instead of one row per changed field.
   */
  private formatDiffsSummary(diffs: FieldDiff[]): string {
    return diffs
      .map((diff) => {
        const label = diff.field
          .replace(/^\w+\./, '')
          .replace(/_/g, ' ')
          .replace(/\b\w/g, (c) => c.toUpperCase());
        return `${label}: ${diff.old_value ?? '—'} → ${diff.new_value ?? '—'}`;
      })
      .join('; ');
  }

  private uppercaseTextValues(data: Record<string, any>): Record<string, any> {
    const result = { ...data };
    for (const [key, val] of Object.entries(result)) {
      if (typeof val === 'string') {
        const lowerKey = key.toLowerCase();
        if (
          lowerKey.includes('email') ||
          lowerKey.includes('url') ||
          lowerKey.includes('pic') ||
          lowerKey.includes('country_code') ||
          lowerKey === 'dob'
        ) {
          continue;
        }
        result[key] = val.toUpperCase();
      }
    }
    return result;
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
      const studentId = diffs.find((d) => d.student_id != null)?.student_id ?? null;
      await this.auditLogs.log({
        entity_type: AUDIT_ENTITY_TYPE,
        entity_id: String(request.id),
        action: 'REQUESTED',
        changed_by: actorLabel,
        student_id: studentId,
        note: `${contextNote} Changes: ${this.formatDiffsSummary(diffs)}`,
      });
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
            primary_phone_country_code: true,
            whatsapp_number: true,
            whatsapp_country_code: true,
            email_address: true,
            cnic: true,
            occupation: true,
            job_position: true,
            organization: true,
            education_level: true,
            mailing_address: true,
            student_guardians: {
              select: {
                relationship: true,
              },
            },
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
      orderBy: { updated_at: 'desc' },
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

  /**
   * Splits requested_data into approved vs remaining portions when the admin
   * selects a subset of fields. Returns null when every field is approved
   * (or approved_fields was omitted / empty meaning "all").
   */
  private partitionRequestedData(
    requestedData: Record<string, unknown>,
    approvedFields?: string[],
  ): {
    approvedData: Record<string, unknown>;
    remainingData: Record<string, unknown> | null;
    isPartial: boolean;
  } {
    const isAccountDeletion =
      requestedData?.request_type === ACCOUNT_DELETION_REQUEST_TYPE;
    if (isAccountDeletion || !approvedFields || approvedFields.length === 0) {
      return { approvedData: requestedData, remainingData: null, isPartial: false };
    }

    const fieldSet = new Set(approvedFields);

    if (requestedData?.request_type === 'STUDENT_UPDATE') {
      const changes = (requestedData.changes as Record<string, unknown>) || {};
      const allKeys = Object.keys(changes);
      const unknown = approvedFields.filter((f) => !allKeys.includes(f));
      if (unknown.length > 0) {
        throw new BadRequestException(
          `Unknown approved fields: ${unknown.join(', ')}`,
        );
      }
      if (approvedFields.length === allKeys.length) {
        return { approvedData: requestedData, remainingData: null, isPartial: false };
      }

      const approvedChanges: Record<string, unknown> = {};
      const remainingChanges: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(changes)) {
        if (fieldSet.has(key)) approvedChanges[key] = value;
        else remainingChanges[key] = value;
      }

      return {
        approvedData: {
          ...requestedData,
          changes: approvedChanges,
        },
        remainingData: {
          ...requestedData,
          changes: remainingChanges,
        },
        isPartial: true,
      };
    }

    // Guardian field updates (flat map)
    const metaKeys = new Set(['request_type', 'student_cc']);
    const dataKeys = Object.keys(requestedData).filter((k) => !metaKeys.has(k));
    const unknown = approvedFields.filter((f) => !dataKeys.includes(f));
    if (unknown.length > 0) {
      throw new BadRequestException(
        `Unknown approved fields: ${unknown.join(', ')}`,
      );
    }
    if (approvedFields.length === dataKeys.length) {
      return { approvedData: requestedData, remainingData: null, isPartial: false };
    }

    const approvedData: Record<string, unknown> = {};
    const remainingData: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(requestedData)) {
      if (metaKeys.has(key)) {
        // Meta keys shouldn't appear on guardian payloads, but keep if present
        continue;
      }
      if (fieldSet.has(key)) approvedData[key] = value;
      else remainingData[key] = value;
    }

    return { approvedData, remainingData, isPartial: true };
  }

  private assertGuardianFieldLengths(data: Record<string, any>) {
    const tooLong: string[] = [];
    for (const [key, value] of Object.entries(data)) {
      if (value == null || typeof value !== 'string') continue;
      const max = GUARDIAN_FIELD_MAX_LENGTHS[key];
      if (max != null && value.length > max) {
        tooLong.push(`${key} (${value.length}/${max} chars)`);
      }
    }
    if (tooLong.length > 0) {
      throw new BadRequestException(
        `Value too long for column(s): ${tooLong.join('; ')}. Shorten the value or ask an admin to widen the column.`,
      );
    }
  }

  private async applyApprovedData(
    tx: Prisma.TransactionClient,
    request: {
      guardian_id: number;
      family_id: number;
    },
    approvedData: Record<string, unknown>,
  ) {
    const isAccountDeletion =
      approvedData?.request_type === ACCOUNT_DELETION_REQUEST_TYPE;
    if (isAccountDeletion) {
      await this.authService.deleteParentAccount(request.family_id);
      return;
    }

    if (approvedData?.request_type === 'STUDENT_UPDATE') {
      const studentCc = Number(approvedData.student_cc);
      const rawChanges = approvedData.changes as Record<string, any>;
      const changes = this.uppercaseTextValues(rawChanges);
      if (changes.dob) {
        changes.dob = new Date(changes.dob);
      }
      await tx.students.update({
        where: { cc: studentCc },
        data: changes,
      });
      if (changes.full_name !== undefined) {
        await invalidateUnpaidVoucherPdfs(tx, [studentCc]);
      }
      return;
    }

    const dataToUpdate = this.uppercaseTextValues({ ...approvedData } as Record<string, any>);
    this.assertGuardianFieldLengths(dataToUpdate);

    if ('home_phone' in dataToUpdate) {
      const homePhone = dataToUpdate.home_phone;
      delete dataToUpdate.home_phone;
      if (request.family_id) {
        await tx.families.update({
          where: { id: request.family_id },
          data: { home_phone: homePhone },
        });
        await tx.students.updateMany({
          where: { family_id: request.family_id },
          data: { home_phone: homePhone },
        });
      }
    }

    const addressFields = [
      'house_appt_name',
      'area_block',
      'city',
      'province',
      'country',
      'postal_code',
    ];
    const hasAddressUpdates = addressFields.some((field) => field in dataToUpdate);

    if (hasAddressUpdates) {
      const currentGuardian = await tx.guardians.findUnique({
        where: { id: request.guardian_id },
        select: {
          house_appt_name: true,
          area_block: true,
          city: true,
          province: true,
          country: true,
          postal_code: true,
        },
      });

      const houseApptName =
        'house_appt_name' in dataToUpdate
          ? dataToUpdate.house_appt_name
          : currentGuardian?.house_appt_name || '';
      const areaBlock =
        'area_block' in dataToUpdate
          ? dataToUpdate.area_block
          : currentGuardian?.area_block || '';
      const city =
        'city' in dataToUpdate ? dataToUpdate.city : currentGuardian?.city || '';
      const province =
        'province' in dataToUpdate
          ? dataToUpdate.province
          : currentGuardian?.province || '';
      const country =
        'country' in dataToUpdate
          ? dataToUpdate.country
          : currentGuardian?.country || '';
      const postalCode =
        'postal_code' in dataToUpdate
          ? dataToUpdate.postal_code
          : currentGuardian?.postal_code || '';

      const addressParts = [
        houseApptName,
        areaBlock,
        city,
        province,
        country,
        postalCode,
      ]
        .map((p) => p?.toString().trim())
        .filter(Boolean);
      dataToUpdate.mailing_address = addressParts.join(', ');
    }

    await tx.guardians.update({
      where: { id: request.guardian_id },
      data: dataToUpdate as Prisma.InputJsonValue,
    });

    if (dataToUpdate.full_name !== undefined) {
      const fatherLinks = await tx.student_guardians.findMany({
        where: { guardian_id: request.guardian_id },
        select: { student_id: true, relationship: true },
      });
      await invalidateUnpaidVoucherPdfs(
        tx,
        fatherLinks
          .filter((l) => isFatherRelationship(l.relationship))
          .map((l) => l.student_id),
      );
    }

    if (dataToUpdate.mailing_address) {
      await tx.families.update({
        where: { id: request.family_id },
        data: { primary_address: dataToUpdate.mailing_address },
      });

      let parsed: Record<string, string | null> = {};
      if (hasAddressUpdates) {
        const currentG = await tx.guardians.findUnique({
          where: { id: request.guardian_id },
          select: {
            house_appt_name: true,
            area_block: true,
            city: true,
            province: true,
            country: true,
            postal_code: true,
          },
        });
        parsed = {
          house_appt_name: currentG?.house_appt_name || null,
          area_block: currentG?.area_block || null,
          city: currentG?.city || null,
          province: currentG?.province || null,
          country: currentG?.country || null,
          postal_code: currentG?.postal_code || null,
        };
      } else {
        parsed = this.parseMailingAddress(dataToUpdate.mailing_address);
      }

      const studentIds = await tx.students.findMany({
        where: { family_id: request.family_id, deleted_at: null },
        select: { cc: true },
      });
      const sccList = studentIds.map((s) => s.cc);

      const guardianLinks = await tx.student_guardians.findMany({
        where: { student_id: { in: sccList } },
        select: { guardian_id: true },
      });
      const guardianIds = Array.from(
        new Set(guardianLinks.map((l) => l.guardian_id)),
      );

      await tx.guardians.updateMany({
        where: { id: { in: guardianIds } },
        data: {
          mailing_address: dataToUpdate.mailing_address,
          ...parsed,
        },
      });
    }
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

    const requestedData = request.requested_data as Record<string, unknown>;
    const isApproving = dto.status === ChangeRequestStatus.APPROVED;

    const { approvedData, remainingData, isPartial } = isApproving
      ? this.partitionRequestedData(requestedData, dto.approved_fields)
      : { approvedData: requestedData, remainingData: null, isPartial: false };

    if (isApproving && dto.approved_fields && dto.approved_fields.length === 0) {
      throw new BadRequestException(
        'Select at least one field to approve, or omit approved_fields to approve all',
      );
    }

    // Diff against current data BEFORE the mutation, scoped to what is being decided.
    const diffs = await this.buildFieldDiffs(
      isApproving ? approvedData : requestedData,
      request.guardian_id,
    );
    const actorLabel = adminLabel || adminId;
    const contextNote =
      `Change request #${id} for Family #${request.family_id} (Guardian: ${request.guardians.full_name ?? request.guardian_id}) ` +
      `${dto.status.toLowerCase()} by ${actorLabel}` +
      (isPartial
        ? ` (partial: ${(dto.approved_fields || []).join(', ')}; remaining fields stay pending).`
        : '.') +
      (dto.comment ? ` Comment: ${dto.comment}` : '') +
      (diffs.length === 0 &&
      requestedData?.request_type === ACCOUNT_DELETION_REQUEST_TYPE
        ? ` Account deletion request. Reason: ${(requestedData as any).reason || 'not provided'}.`
        : '');

    const result = await this.prisma.$transaction(async (tx) => {
      if (isApproving && isPartial && remainingData) {
        // Atomic guard: only proceed if the request is still PENDING. This closes
        // the race where two concurrent requests both pass the pre-transaction
        // status check and each end up applying the change + writing audit logs.
        const guard = await tx.parent_change_requests.updateMany({
          where: { id, status: 'PENDING' },
          data: {
            requested_data: remainingData as any,
          },
        });

        if (guard.count === 0) {
          throw new BadRequestException('Request has already been processed');
        }

        // Apply selected fields, move them into a new History (APPROVED) row,
        // and leave the original request PENDING with only unselected fields.
        await this.applyApprovedData(tx, request, approvedData);

        const historyRequest = await tx.parent_change_requests.create({
          data: {
            guardian_id: request.guardian_id,
            family_id: request.family_id,
            requested_data: approvedData as any,
            status: ChangeRequestStatus.APPROVED,
            comment: dto.comment ?? null,
            processed_by: adminId,
            processed_at: new Date(),
          },
        });

        const pendingRequest = await tx.parent_change_requests.findUniqueOrThrow({
          where: { id },
        });

        return { result: pendingRequest, historyId: historyRequest.id };
      }

      const guard = await tx.parent_change_requests.updateMany({
        where: { id, status: 'PENDING' },
        data: {
          status: dto.status,
          comment: dto.comment,
          processed_by: adminId,
          processed_at: new Date(),
          ...(isApproving
            ? { requested_data: approvedData as any }
            : {}),
        },
      });

      if (guard.count === 0) {
        throw new BadRequestException('Request has already been processed');
      }

      if (isApproving) {
        await this.applyApprovedData(tx, request, approvedData);
      }

      const updatedRequest = await tx.parent_change_requests.findUniqueOrThrow({
        where: { id },
      });

      return { result: updatedRequest, historyId: id };
    });

    const logEntityId = String(result.historyId);
    if (diffs.length === 0) {
      await this.auditLogs.log({
        entity_type: AUDIT_ENTITY_TYPE,
        entity_id: logEntityId,
        action: dto.status,
        changed_by: actorLabel,
        note: contextNote,
      });
    } else {
      const studentId = diffs.find((d) => d.student_id != null)?.student_id ?? null;
      await this.auditLogs.log({
        entity_type: AUDIT_ENTITY_TYPE,
        entity_id: logEntityId,
        action: dto.status,
        changed_by: actorLabel,
        student_id: studentId,
        note: `${contextNote} Changes: ${this.formatDiffsSummary(diffs)}`,
      });
    }

    // Trigger notice board notification to the family
    try {
      const isDeletion =
        (request.requested_data as any)?.request_type ===
        ACCOUNT_DELETION_REQUEST_TYPE;
      // If account was approved for deletion, the parent account is deleted and tokens revoked, no notification needed.
      if (!(isDeletion && isApproving)) {
        const titleTemplateKey = isApproving
          ? 'notif_profile_approved_title'
          : 'notif_profile_rejected_title';
        const isDisabled = await isTemplateDisabled(this.prisma, titleTemplateKey);

        if (!isDisabled) {
          let title = '';
          let body = '';
          if (isApproving) {
            title = await resolveTemplate(
              this.prisma,
              'notif_profile_approved_title',
              'Profile Update Approved',
            );
            body = await resolveTemplate(
              this.prisma,
              'notif_profile_approved_body',
              isPartial
                ? 'Some of your profile changes have been approved and synced. Remaining fields are still under review.'
                : 'Your profile change request has been approved and synced successfully.',
            );
          } else {
            title = await resolveTemplate(
              this.prisma,
              'notif_profile_rejected_title',
              'Profile Update Rejected',
            );
            body = await resolveTemplate(
              this.prisma,
              'notif_profile_rejected_body',
              'Your profile change request has been rejected.{reason_clause}',
              {
                comment: dto.comment || '',
                reason_clause: dto.comment ? ` Reason: ${dto.comment}` : '',
              },
            );
          }

          const studentCcs: number[] = [];
          if (
            requestedData?.request_type === 'STUDENT_UPDATE' &&
            requestedData.student_cc
          ) {
            studentCcs.push(Number(requestedData.student_cc));
          } else {
            const students = await this.prisma.students.findMany({
              where: { family_id: request.family_id, deleted_at: null },
              select: { cc: true },
            });
            studentCcs.push(...students.map((s) => s.cc));
          }

          await this.noticeBoardService.createPost(
            adminId,
            {
              title,
              body,
              student_ccs: studentCcs,
              is_pinned: false,
              notification_only: false,
            },
            adminLabel,
          );
        }
      }
    } catch (err) {
      console.error(
        'Failed to dispatch parent change request process notification:',
        err.message,
      );
    }

    return result.result;
  }

  private parseMailingAddress(addressStr: string) {
    const parts = addressStr.split(',').map(p => p.trim());
    
    let country = 'PAKISTAN';
    let province = 'SINDH';
    let city = 'KARACHI';
    let area_block = 'N/A';
    let house_appt_name = addressStr;

    if (parts.length >= 3) {
      const last = parts[parts.length - 1].toUpperCase();
      let offset = 0;
      if (last.includes('PAKISTAN')) {
        country = 'PAKISTAN';
        offset++;
      }
      const provs = ['SINDH', 'PUNJAB', 'BALOCHISTAN', 'KPK', 'GILGIT'];
      const currentProvPart = parts[parts.length - 1 - offset]?.toUpperCase() || '';
      const matchedProv = provs.find(p => currentProvPart.includes(p));
      if (matchedProv) {
        province = matchedProv;
        offset++;
      }
      
      const currentCityPart = parts[parts.length - 1 - offset]?.toUpperCase() || '';
      if (currentCityPart) {
        city = currentCityPart;
        offset++;
      }

      if (parts.length - 1 - offset >= 0) {
        area_block = parts[parts.length - 1 - offset];
        offset++;
      }

      if (parts.length - 1 - offset >= 0) {
        house_appt_name = parts.slice(0, parts.length - offset + 1).join(', ');
      } else {
        house_appt_name = parts[0];
      }
    } else {
      const upper = addressStr.toUpperCase();
      if (upper.includes('KARACHI')) {
        city = 'KARACHI';
        province = 'SINDH';
      } else if (upper.includes('LAHORE')) {
        city = 'LAHORE';
        province = 'PUNJAB';
      } else if (upper.includes('ISLAMABAD')) {
        city = 'ISLAMABAD';
        province = 'PUNJAB';
      }

      const blockIndex = upper.indexOf('BLOCK');
      if (blockIndex !== -1) {
        house_appt_name = addressStr.substring(0, blockIndex).trim();
        area_block = addressStr.substring(blockIndex).replace(/KARACHI|SINDH|PAKISTAN/gi, '').trim();
      } else {
        house_appt_name = addressStr.replace(/KARACHI|SINDH|PAKISTAN/gi, '').trim();
      }
    }

    return {
      country: country.substring(0, 50).toUpperCase(),
      province: province.substring(0, 50).toUpperCase(),
      city: city.substring(0, 50).toUpperCase(),
      area_block: area_block.substring(0, 100).toUpperCase(),
      house_appt_name: house_appt_name.substring(0, 255).toUpperCase(),
    };
  }
}
