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

@Injectable()
export class FamiliesService {
  constructor(private readonly prisma: PrismaService) { }

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
                email_address: true,
                cnic: true,
                occupation: true,
              },
            },
          },
        })
        : [];

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { password_hash, ...safeFamily } = family;
    return {
      ...safeFamily,
      guardians: guardians.map((sg) => ({ ...sg.guardians, relationship: sg.relationship })),
    };
  }

  // ── Create ────────────────────────────────────────────────────────────────

  async createFamily(dto: CreateFamilyDto) {
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

    return family;
  }

  // ── Update ────────────────────────────────────────────────────────────────

  async updateFamily(id: number, dto: UpdateFamilyDto) {
    await this._assertExists(id);

    const password_hash = dto.password
      ? await bcrypt.hash(dto.password, 10)
      : undefined;

    const updated = await this.prisma.families.update({
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

    return updated;
  }

  // ── Assign child to family ────────────────────────────────────────────────

  async assignChildToFamily(familyId: number, studentId: number) {
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

    const allSiblingIds = [...targetSiblings.map((s) => s.cc), studentId];

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
      for (const [rel, familyGuardians] of hostByRel.entries()) {
        if (!incomingRels.has(rel)) {
          // New student doesn't have this role (e.g. FATHER), but family does. Pick the best one.
          const bestFamilyG = familyGuardians.find(g => !isPlaceholder(g)) || familyGuardians[0];
          if (bestFamilyG && !isPlaceholder(bestFamilyG)) {
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
          }
        }
      }

      return s;
    });

    return updated;
  }

  async initializeFamilyFromStudent(studentId: number) {
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

    return await this.prisma.$transaction(async (tx) => {
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
