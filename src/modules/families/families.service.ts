import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../../prisma/prisma.service';
import { QueryFamiliesDto } from './dto/query-families.dto';
import { CreateFamilyDto } from './dto/create-family.dto';
import { UpdateFamilyDto } from './dto/update-family.dto';
import { calculateOffset } from '../../utils/pagination.util';
import { createPaginationMeta } from '../../utils/serializer.util';

import { AuditLogsService } from '../audit-logs/audit-logs.service';

@Injectable()
export class FamiliesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) { }

  // ── List (paginated + search) ─────────────────────────────────────────────

  async listFamilies(query: QueryFamiliesDto) {
    const { page = 1, limit = 10, search } = query;
    const offset = calculateOffset(page, limit);

    const isNumeric = search && /^\d+$/.test(search);
    const where = {
      deleted_at: null,
      ...(search
        ? {
          OR: [
            { household_name: { contains: search, mode: 'insensitive' as const } },
            { email: { contains: search, mode: 'insensitive' as const } },
            { legacy_pid: { contains: search, mode: 'insensitive' as const } },
            ...(isNumeric ? [{ id: Number(search) }] : []),
            // Search by sibling CC (if numeric)
            ...(isNumeric ? [{ students: { some: { cc: Number(search), deleted_at: null } } }] : []),
            // Search by sibling GR Number
            { students: { some: { gr_number: { contains: search, mode: 'insensitive' as const }, deleted_at: null } } },
            // Search by guardian CNIC  →  families → students → student_guardians → guardians
            {
              students: {
                some: {
                  deleted_at: null,
                  student_guardians: {
                    some: {
                      guardians: {
                        cnic: { contains: search, mode: 'insensitive' as const },
                      },
                    },
                  },
                },
              },
            },
          ],
        }
        : {}),
    };

    const [families, total] = await this.prisma.$transaction([
      this.prisma.families.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: offset,
        take: limit,
        select: {
          id: true,
          household_name: true,
          email: true,
          primary_address: true,
          legacy_pid: true,
          created_at: true,
          students: {
            where: { deleted_at: null },
            select: {
              cc: true,
              full_name: true,
              gr_number: true,
              student_guardians: {
                where: { is_primary_contact: true },
                take: 1,
                select: {
                  guardians: {
                    select: {
                      full_name: true,
                      cnic: true,
                    }
                  }
                }
              }
            }
          }
        },
      }),
      this.prisma.families.count({ where }),
    ]);

    return {
      families: families.map((f) => {
        const primaryGuardian = f.students?.find(s => s.student_guardians?.[0])?.student_guardians?.[0]?.guardians;
        return {
          ...f,
          students: f.students.map(s => ({
            cc: s.cc,
            full_name: s.full_name,
            gr_number: s.gr_number
          })),
          primary_guardian: primaryGuardian ? {
            name: primaryGuardian.full_name,
            cnic: primaryGuardian.cnic,
          } : null,
          student_count: f.students.length,
        };
      }),
      meta: createPaginationMeta(page, limit, total),
    };
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  async getFamilyStats() {
    const [total, activeWithChildren, withCredentials, kidsInCredentialedFamilies] =
      await this.prisma.$transaction([
        // Total non-deleted families
        this.prisma.families.count({
          where: { deleted_at: null },
        }),
        // Families with at least one currently-enrolled (active) child
        this.prisma.families.count({
          where: {
            deleted_at: null,
            students: { some: { deleted_at: null, status: 'ENROLLED' } },
          },
        }),
        // Families that have set both an email and an app password
        this.prisma.families.count({
          where: {
            deleted_at: null,
            email: { not: null },
            password_hash: { not: null },
          },
        }),
        // Enrolled students belonging to families with credentials set
        this.prisma.students.count({
          where: {
            deleted_at: null,
            status: 'ENROLLED',
            families: {
              deleted_at: null,
              email: { not: null },
              password_hash: { not: null },
            },
          },
        }),
      ]);

    return { total, activeWithChildren, withCredentials, kidsInCredentialedFamilies };
  }

  // ── Get one (with students + guardians) ───────────────────────────────────

  async getFamilyById(id: number) {
    const family = await this.prisma.families.findFirst({
      where: { id, deleted_at: null },
      include: {
        students: {
          where: { deleted_at: null },
          select: {
            cc: true,
            full_name: true,
            gr_number: true,
            status: true,
            photograph_url: true,
            campuses: { select: { campus_name: true, campus_code: true } },
          },
        },
        student_siblings: true,
      },
    });

    if (!family) throw new NotFoundException(`Family #${id} not found`);

    // Collect guardian info via student_guardians junction
    const studentIds = family.students.map((s) => s.cc);
    const guardians =
      studentIds.length > 0
        ? await this.prisma.student_guardians.findMany({
          where: { student_id: { in: studentIds } },
          distinct: ['guardian_id'],
          include: {
            guardians: {
              select: {
                id: true,
                full_name: true,
                primary_phone: true,
                primary_phone_country_code: true,
                email_address: true,
                cnic: true,
                occupation: true,
                additional_phones: true,
                photo_url: true,
                whatsapp_number: true,
                whatsapp_country_code: true,
                house_appt_name: true,
                house_appt_number: true,
                area_block: true,
                city: true,
                postal_code: true,
                province: true,
                country: true,
                work_phone: true,
                work_phone_country_code: true,
                mailing_address: true,
              },
            },
          },
        })
        : [];

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { password_hash, ...safeFamily } = family;
    return {
      ...safeFamily,
      has_password: !!password_hash,
      guardians: guardians.map((sg) => ({
        ...sg.guardians,
        relationship: sg.relationship,
        is_primary_contact: sg.is_primary_contact,
        is_emergency_contact: sg.is_emergency_contact,
      })),
    };
  }

  // ── Create ────────────────────────────────────────────────────────────────

  async createFamily(dto: CreateFamilyDto, changedBy?: string) {
    const password_hash = dto.password
      ? await bcrypt.hash(dto.password, 10)
      : null;

    const family = await this.prisma.families.create({
      data: {
        household_name: dto.household_name,
        primary_address: dto.primary_address,
        email: dto.email,
        password_hash,
        legacy_pid: dto.legacy_pid,
      },
      select: {
        id: true,
        household_name: true,
        email: true,
        primary_address: true,
        legacy_pid: true,
        created_at: true,
      },
    });

    const noteParts = [
      `Created family #${family.id} ("${family.household_name}")`,
      family.email ? `email ${family.email}` : null,
      family.legacy_pid ? `legacy_pid ${family.legacy_pid}` : null,
      password_hash ? 'password set' : null,
    ].filter(Boolean);

    await this.auditLogs.log({
      entity_type: 'FAMILY',
      entity_id: String(family.id),
      action: 'CREATED',
      new_value: family.household_name,
      changed_by: changedBy ?? 'system',
      note: noteParts.join(' | '),
    });

    return family;
  }

  // ── Update ────────────────────────────────────────────────────────────────

  async updateFamily(id: number, dto: UpdateFamilyDto, changedBy?: string) {
    const before = await this._assertExists(id);

    let password_hash: string | null | undefined = undefined;
    if (dto.password !== undefined) {
      password_hash = dto.password ? await bcrypt.hash(dto.password, 10) : null;
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const family = await tx.families.update({
        where: { id },
        data: {
          ...(dto.household_name !== undefined && { household_name: dto.household_name }),
          ...(dto.primary_address !== undefined && { primary_address: dto.primary_address }),
          ...(dto.email !== undefined && { email: dto.email }),
          ...(password_hash !== undefined && { password_hash }),
          ...(dto.legacy_pid !== undefined && { legacy_pid: dto.legacy_pid }),
        },
        select: {
          id: true,
          household_name: true,
          email: true,
          primary_address: true,
          legacy_pid: true,
          created_at: true,
        },
      });

      if (password_hash !== undefined) {
        await tx.family_refresh_tokens.deleteMany({
          where: { family_id: id },
        });
      }

      return family;
    });

    const fieldChanges: string[] = [];
    if (dto.household_name !== undefined && before.household_name !== updated.household_name) {
      fieldChanges.push(`household_name "${before.household_name ?? '—'}" → "${updated.household_name ?? '—'}"`);
    }
    if (dto.primary_address !== undefined && before.primary_address !== updated.primary_address) {
      fieldChanges.push(`address "${before.primary_address ?? '—'}" → "${updated.primary_address ?? '—'}"`);
    }
    if (dto.email !== undefined && before.email !== updated.email) {
      fieldChanges.push(`email "${before.email ?? '—'}" → "${updated.email ?? '—'}"`);
    }
    if (dto.legacy_pid !== undefined && before.legacy_pid !== updated.legacy_pid) {
      fieldChanges.push(`legacy_pid "${before.legacy_pid ?? '—'}" → "${updated.legacy_pid ?? '—'}"`);
    }
    if (password_hash !== undefined) {
      fieldChanges.push(password_hash ? 'password set/changed (tokens revoked)' : 'password cleared (tokens revoked)');
    }

    await this.auditLogs.log({
      entity_type: 'FAMILY',
      entity_id: String(id),
      action: 'UPDATED',
      changed_by: changedBy ?? 'system',
      note: fieldChanges.length > 0
        ? `Family #${id} ("${before.household_name}") updated: ${fieldChanges.join(', ')}.`
        : `Family #${id} ("${before.household_name}") update submitted with no effective changes.`,
    });

    return updated;
  }

  // ── Assign child to family ────────────────────────────────────────────────

  async assignChildToFamily(familyId: number, studentId: number, changedBy: string) {
    const [family, student] = await Promise.all([
      this.prisma.families.findFirst({
        where: { id: familyId, deleted_at: null },
        include: { students: { where: { deleted_at: null }, take: 1 } },
      }),
      this.prisma.students.findFirst({
        where: { cc: studentId, deleted_at: null },
      }),
    ]);

    if (!family) throw new NotFoundException(`Family #${familyId} not found`);
    if (!student) throw new NotFoundException(`Student #${studentId} not found`);

    if (student.family_id === familyId) {
      throw new ConflictException(
        `Student #${studentId} is already in family #${familyId}`,
      );
    }

    // Fetch target family siblings and the incoming student's current guardians
    const [targetSiblings, incomingGuardians] = await Promise.all([
      this.prisma.students.findMany({
        where: { family_id: familyId, deleted_at: null },
        include: { student_guardians: { include: { guardians: true } } },
      }),
      this.prisma.student_guardians.findMany({
        where: { student_id: studentId },
        include: { guardians: true },
      }),
    ]);

    const previousFamilyId = student.family_id;
    const siblingSummary = targetSiblings.length > 0
      ? targetSiblings.map((s) => `#${s.cc} (${s.full_name ?? 'unnamed'})`).join(', ')
      : 'none';

    const updated = await this.prisma.$transaction(async (tx) => {
      // 1. Update the incoming student's family link
      const s = await tx.students.update({
        where: { cc: studentId },
        data: { family_id: familyId },
        select: { cc: true, full_name: true, family_id: true },
      });

      // 2. Smart Merge Guardians for the Incoming Student only
      // We don't want to touch existing siblings' guardians anymore (prevents overwriting different mothers)
      
      const isPlaceholder = (g: any) => {
        const name = (g?.guardians?.full_name || '').trim().toUpperCase();
        return !name || name === 'NOT PROVIDED' || name === 'NULL' || name === 'N/A' || name === 'NONE';
      };

      // Collect "Canonical" guardians from the family (from any existing sibling)
      const hostByRel = new Map<string, any[]>();
      for (const sib of targetSiblings) {
        for (const sg of sib.student_guardians) {
          if (!sg.relationship) continue;
          const rel = sg.relationship.trim().toUpperCase();
          if (!hostByRel.has(rel)) hostByRel.set(rel, []);
          hostByRel.get(rel)!.push(sg);
        }
      }

      // For each relationship the incoming student has, try to find a match in the family
      for (const iSG of incomingGuardians) {
        if (!iSG.relationship) continue;
        const rel = iSG.relationship.trim().toUpperCase();
        const familyOptions = hostByRel.get(rel) || [];
        
        // Look for a physical match (same person) in the family options
        const match = familyOptions.find(fSG => {
          const iCNIC = iSG.guardians.cnic?.trim();
          const fCNIC = fSG.guardians.cnic?.trim();
          if (iCNIC && fCNIC && iCNIC === fCNIC) return true;
          
          const iName = iSG.guardians.full_name?.trim().toUpperCase();
          const fName = fSG.guardians.full_name?.trim().toUpperCase();
          if (iName && fName && iName === fName && !isPlaceholder(iSG)) return true;
          
          return false;
        });

        if (match && match.guardian_id !== iSG.guardian_id) {
          // Sync point: The incoming student's parent is already in the family under a different ID (or we want to converge to one)
          // Actually, if it's a match, we should update the student_guardian link to point to the family's canonical guardian ID
          await tx.student_guardians.update({
            where: { student_id_guardian_id: { student_id: studentId, guardian_id: iSG.guardian_id } },
            data: { guardian_id: match.guardian_id }
          });
        }
      }

      // Enrichment: If the incoming student is missing a relationship that the family HAS, add it
      const incomingRels = new Set(incomingGuardians.map(g => g.relationship?.trim().toUpperCase()).filter(Boolean));
      const incomingGuardianIds = new Set(incomingGuardians.map(g => g.guardian_id));
      for (const [rel, familyGuardians] of hostByRel.entries()) {
        if (!incomingRels.has(rel)) {
          // New student doesn't have this role (e.g. FATHER), but family does. Pick the best one.
          const bestFamilyG = familyGuardians.find(g => !isPlaceholder(g)) || familyGuardians[0];
          if (bestFamilyG && !isPlaceholder(bestFamilyG)) {
             // Avoid primary key / unique constraint collision if the student is already linked to this guardian ID
             if (incomingGuardianIds.has(bestFamilyG.guardian_id)) {
               continue;
             }
             
             // Create link for the new student
             await tx.student_guardians.create({
                data: {
                  student_id: studentId,
                  guardian_id: bestFamilyG.guardian_id,
                  relationship: rel,
                  is_primary_contact: false,
                  is_emergency_contact: false,
                }
             });
             incomingGuardianIds.add(bestFamilyG.guardian_id);
          }
        }
      }

      return s;
    });

    await this.auditLogs.log({
      entity_type: 'FAMILY',
      entity_id: String(familyId),
      action: 'UPDATED',
      field: 'family.student_assignment',
      old_value: previousFamilyId != null ? String(previousFamilyId) : null,
      new_value: String(familyId),
      changed_by: changedBy,
      student_id: studentId,
      note: `Assigned student #${studentId} (${student.full_name ?? 'unnamed'}) to family #${familyId} ("${family.household_name}")` +
        (previousFamilyId != null ? ` from family #${previousFamilyId}` : ' (was unassigned)') +
        `. Existing siblings: ${siblingSummary}.`,
    });

    return updated;
  }

  async initializeFamilyFromStudent(studentId: number, changedBy?: string) {
    const student = await this.prisma.students.findFirst({
      where: { cc: studentId, deleted_at: null },
      include: {
        student_guardians: {
          include: { guardians: true },
          where: { is_primary_contact: true },
        },
      },
    });

    if (!student) throw new NotFoundException(`Student #${studentId} not found`);
    if (student.family_id) {
      throw new ConflictException(`Student #${studentId} already has a family assigned`);
    }

    const primaryGuardian = student.student_guardians[0]?.guardians;
    const householdName = primaryGuardian?.full_name
      ? `Family of ${primaryGuardian.full_name}`
      : `Family of ${student.full_name}`;

    const addressChunks = primaryGuardian
      ? [
          primaryGuardian.house_appt_number,
          primaryGuardian.house_appt_name,
          primaryGuardian.area_block,
          primaryGuardian.city,
          primaryGuardian.province,
          primaryGuardian.country,
          primaryGuardian.postal_code
        ]
      : [];
    const address = addressChunks.filter(Boolean).join(', ') || null;

    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Create Family
      const family = await tx.families.create({
        data: {
          household_name: householdName,
          primary_address: address,
          home_phone: student.home_phone,
        },
      });

      // 2. Link Student
      await tx.students.update({
        where: { cc: studentId },
        data: { family_id: family.id },
      });

      return { ...family, students: [student] };
    });

    await this.auditLogs.log({
      entity_type: 'FAMILY',
      entity_id: String(result.id),
      action: 'CREATED',
      new_value: householdName,
      changed_by: changedBy ?? 'system',
      student_id: studentId,
      note: `Initialized family #${result.id} ("${householdName}") from student #${studentId} (${student.full_name ?? 'unnamed'})` +
        (primaryGuardian?.full_name ? ` via primary guardian ${primaryGuardian.full_name}` : '') +
        (address ? ` | address ${address}` : '') + '.',
    });

    return result;
  }

  // ── Remove child from family ──────────────────────────────────────────────

  async removeChildFromFamily(familyId: number, studentId: number) {
    await this._assertExists(familyId);

    const student = await this.prisma.students.findFirst({
      where: { cc: studentId, deleted_at: null, family_id: familyId },
    });
    if (!student) {
      throw new NotFoundException(
        `Student #${studentId} not found in family #${familyId}`,
      );
    }

    // family_id is a required non-nullable FK — we cannot null it out.
    // Instead we prevent accidental removal without a destination.
    // No audit log: this path always throws before mutating state.
    throw new BadRequestException(
      'Use the assign endpoint to move the student to another family first.',
    );
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private async _assertExists(id: number) {
    const family = await this.prisma.families.findFirst({
      where: { id, deleted_at: null },
    });
    if (!family) throw new NotFoundException(`Family #${id} not found`);
    return family;
  }
}
