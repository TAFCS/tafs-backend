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

  private uppercaseTextValues(data: Record<string, any>): Record<string, any> {
    const result = { ...data };
    for (const [key, val] of Object.entries(result)) {
      if (typeof val === 'string') {
        const lowerKey = key.toLowerCase();
        if (
          lowerKey.includes('email') ||
          lowerKey.includes('url') ||
          lowerKey.includes('pic') ||
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
          const rawChanges = requestedData.changes as Record<string, any>;
          const changes = this.uppercaseTextValues(rawChanges);
          // Parse date if dob is present
          if (changes.dob) {
            changes.dob = new Date(changes.dob);
          }
          await tx.students.update({
            where: { cc: studentCc },
            data: changes,
          });
        } else {
          const rawData = request.requested_data as Record<string, any>;
          const dataToUpdate = this.uppercaseTextValues(rawData);
          
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

          // If any structured address fields are being updated
          const addressFields = ['house_appt_name', 'area_block', 'city', 'province', 'country', 'postal_code'];
          const hasAddressUpdates = addressFields.some(field => field in dataToUpdate);

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
              }
            });

            const houseApptName = 'house_appt_name' in dataToUpdate ? dataToUpdate.house_appt_name : (currentGuardian?.house_appt_name || '');
            const areaBlock = 'area_block' in dataToUpdate ? dataToUpdate.area_block : (currentGuardian?.area_block || '');
            const city = 'city' in dataToUpdate ? dataToUpdate.city : (currentGuardian?.city || '');
            const province = 'province' in dataToUpdate ? dataToUpdate.province : (currentGuardian?.province || '');
            const country = 'country' in dataToUpdate ? dataToUpdate.country : (currentGuardian?.country || '');
            const postalCode = 'postal_code' in dataToUpdate ? dataToUpdate.postal_code : (currentGuardian?.postal_code || '');

            const addressParts = [houseApptName, areaBlock, city, province, country, postalCode].map(p => p?.toString().trim()).filter(Boolean);
            const mailingAddress = addressParts.join(', ');

            dataToUpdate.mailing_address = mailingAddress;
          }

          await tx.guardians.update({
            where: { id: request.guardian_id },
            data: dataToUpdate as Prisma.InputJsonValue,
          });

          // Sync mailing_address to families.primary_address on approval
          if (dataToUpdate.mailing_address) {
            await tx.families.update({
              where: { id: request.family_id },
              data: { primary_address: dataToUpdate.mailing_address },
            });

            // Parse and sync to all family guardians' structured fields
            let parsed = {};
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
                }
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
            const sccList = studentIds.map(s => s.cc);

            const guardianLinks = await tx.student_guardians.findMany({
              where: { student_id: { in: sccList } },
              select: { guardian_id: true },
            });
            const guardianIds = Array.from(new Set(guardianLinks.map(l => l.guardian_id)));

            await tx.guardians.updateMany({
              where: { id: { in: guardianIds } },
              data: {
                mailing_address: dataToUpdate.mailing_address,
                ...parsed,
              },
            });
          }
        }
      }

      return updatedRequest;
    });

    await logProcessedDiffs();

    // Trigger notice board notification to the family
    try {
      const isDeletion = (request.requested_data as any)?.request_type === ACCOUNT_DELETION_REQUEST_TYPE;
      // If account was approved for deletion, the parent account is deleted and tokens revoked, no notification needed.
      if (!(isDeletion && dto.status === ChangeRequestStatus.APPROVED)) {
        const titleTemplateKey = dto.status === ChangeRequestStatus.APPROVED ? 'notif_profile_approved_title' : 'notif_profile_rejected_title';
        const isDisabled = await isTemplateDisabled(this.prisma, titleTemplateKey);
        
        if (!isDisabled) {
          let title = '';
          let body = '';
          if (dto.status === ChangeRequestStatus.APPROVED) {
            title = await resolveTemplate(
              this.prisma,
              'notif_profile_approved_title',
              'Profile Update Approved',
            );
            body = await resolveTemplate(
              this.prisma,
              'notif_profile_approved_body',
              'Your profile change request has been approved and synced successfully.',
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

          // Get student CCs if this is a student update so the notice can be targeted directly to the family's students
          const studentCcs: number[] = [];
          const requestedData = request.requested_data as Record<string, unknown>;
          if (requestedData?.request_type === 'STUDENT_UPDATE' && requestedData.student_cc) {
            studentCcs.push(Number(requestedData.student_cc));
          } else {
            // If it's a guardian change, target all students in the family so the family feed gets it.
            const students = await this.prisma.students.findMany({
              where: { family_id: request.family_id, deleted_at: null },
              select: { cc: true },
            });
            studentCcs.push(...students.map((s) => s.cc));
          }

          // Delegate entire creation, logging, WebSockets, and FCM dispatch to NoticeBoardService
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
      console.error('Failed to dispatch parent change request process notification:', err.message);
    }

    return result;
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
      house_appt_name: house_appt_name.substring(0, 100).toUpperCase(),
    };
  }
}
