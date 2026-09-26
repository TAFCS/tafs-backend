import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { ScopeService } from '../../../common/scope/scope.service';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';

import { IsInt, IsOptional, IsString, IsObject } from 'class-validator';

export class CreatePolicySetDto {
  @IsInt()
  campus_id: number;

  @IsString()
  academic_year: string;

  @IsString()
  effective_from: string;

  @IsOptional()
  @IsString()
  description?: string;
}

export class CreatePolicyRuleDto {
  @IsString()
  rule_type: string;

  @IsObject()
  value_json: any;

  @IsOptional()
  @IsString()
  applies_to?: string;

  @IsOptional()
  @IsString()
  description?: string;
}

@Injectable()
export class PoliciesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly scope: ScopeService,
  ) {}

  /**
   * The caller must be able to act on this campus (their campus scope).
   * `user` omitted means an
   * internal caller.
   */
  private assertCampus(user: IJwtStaffPayload | undefined, campusId: number | null | undefined) {
    if (!user) return;
    this.scope.assertCampus(user, campusId ?? null);
  }

  private canSeeCampus(user: IJwtStaffPayload | undefined, campusId: number | null | undefined) {
    try {
      this.assertCampus(user, campusId);
      return true;
    } catch {
      return false;
    }
  }

  async findAllSets(campusId: number, user?: IJwtStaffPayload) {
    this.assertCampus(user, campusId);
    return this.prisma.hr_policy_sets.findMany({
      where: { campus_id: campusId },
      include: { hr_policy_rules: true },
      orderBy: { effective_from: 'desc' },
    });
  }

  async findOneSet(id: number, user?: IJwtStaffPayload) {
    const set = await this.prisma.hr_policy_sets.findUnique({
      where: { id },
      include: { hr_policy_rules: true }
    });
    // Missing and out-of-scope both 404.
    if (!set || !this.canSeeCampus(user, set.campus_id)) {
      throw new NotFoundException(`Policy set with ID ${id} not found`);
    }
    return set;
  }

  async createSet(dto: CreatePolicySetDto, changedBy: string, user?: IJwtStaffPayload) {
    this.assertCampus(user, dto.campus_id);
    const created = await this.prisma.hr_policy_sets.create({
      data: {
        campus_id: dto.campus_id,
        academic_year: dto.academic_year,
        effective_from: new Date(dto.effective_from),
        description: dto.description || null
      }
    });
    void this.auditLogs.log({
      entity_type: 'HR_POLICY_SET',
      entity_id: String(created.id),
      action: 'CREATED',
      changed_by: changedBy,
      note: `Policy set for academic year ${created.academic_year}, effective ${created.effective_from.toISOString().slice(0, 10)}.${created.description ? ` ${created.description}` : ''}`,
    });
    return created;
  }

  async updateSet(id: number, dto: Partial<CreatePolicySetDto>, changedBy: string, user?: IJwtStaffPayload) {
    const existing = await this.findOneSet(id, user);
    if (dto.campus_id != null && dto.campus_id !== existing.campus_id) this.assertCampus(user, dto.campus_id);
    const updated = await this.prisma.hr_policy_sets.update({
      where: { id },
      data: {
        campus_id: dto.campus_id,
        academic_year: dto.academic_year,
        effective_from: dto.effective_from ? new Date(dto.effective_from) : undefined,
        description: dto.description
      }
    });

    const changes: string[] = [];
    if (dto.academic_year !== undefined && dto.academic_year !== existing.academic_year) {
      changes.push(`Academic Year: ${existing.academic_year} → ${dto.academic_year}`);
    }
    if (dto.effective_from !== undefined) {
      const newDate = new Date(dto.effective_from).toISOString().slice(0, 10);
      const oldDate = existing.effective_from.toISOString().slice(0, 10);
      if (newDate !== oldDate) changes.push(`Effective From: ${oldDate} → ${newDate}`);
    }
    if (dto.description !== undefined && dto.description !== existing.description) {
      changes.push(`Description: ${existing.description ?? '—'} → ${dto.description ?? '—'}`);
    }
    if (dto.campus_id !== undefined && dto.campus_id !== existing.campus_id) {
      changes.push(`Campus: ${existing.campus_id} → ${dto.campus_id}`);
    }

    void this.auditLogs.log({
      entity_type: 'HR_POLICY_SET',
      entity_id: String(id),
      action: 'UPDATED',
      changed_by: changedBy,
      note: changes.length > 0 ? changes.join('; ') : 'No field changes detected.',
    });
    return updated;
  }

  async removeSet(id: number, changedBy: string, user?: IJwtStaffPayload) {
    const existing = await this.findOneSet(id, user);
    const deleted = await this.prisma.hr_policy_sets.delete({
      where: { id }
    });
    void this.auditLogs.log({
      entity_type: 'HR_POLICY_SET',
      entity_id: String(id),
      action: 'DELETED',
      changed_by: changedBy,
      note: `Deleted policy set for academic year ${existing.academic_year}, effective ${existing.effective_from.toISOString().slice(0, 10)}.`,
    });
    return deleted;
  }

  // Rules CRUD
  async createRule(setId: number, dto: CreatePolicyRuleDto, changedBy: string, user?: IJwtStaffPayload) {
    await this.findOneSet(setId, user);
    const created = await this.prisma.hr_policy_rules.create({
      data: {
        policy_set_id: setId,
        rule_type: dto.rule_type,
        value_json: dto.value_json,
        applies_to: dto.applies_to || null,
        description: dto.description || null
      }
    });
    void this.auditLogs.log({
      entity_type: 'HR_POLICY_RULE',
      entity_id: String(created.id),
      action: 'CREATED',
      changed_by: changedBy,
      note: `Rule "${created.rule_type}" on policy set #${setId}${created.applies_to ? `, applies to ${created.applies_to}` : ''}.${created.description ? ` ${created.description}` : ''}`,
    });
    return created;
  }

  async updateRule(setId: number, ruleId: number, dto: Partial<CreatePolicyRuleDto>, changedBy: string, user?: IJwtStaffPayload) {
    await this.findOneSet(setId, user);
    const rule = await this.prisma.hr_policy_rules.findUnique({
      where: { id: ruleId }
    });
    if (!rule || rule.policy_set_id !== setId) {
      throw new NotFoundException(`Rule with ID ${ruleId} not found in policy set ${setId}`);
    }
    const updated = await this.prisma.hr_policy_rules.update({
      where: { id: ruleId },
      data: {
        rule_type: dto.rule_type,
        value_json: dto.value_json,
        applies_to: dto.applies_to,
        description: dto.description
      }
    });

    const changes: string[] = [];
    if (dto.rule_type !== undefined && dto.rule_type !== rule.rule_type) {
      changes.push(`Rule Type: ${rule.rule_type} → ${dto.rule_type}`);
    }
    if (dto.applies_to !== undefined && dto.applies_to !== rule.applies_to) {
      changes.push(`Applies To: ${rule.applies_to ?? '—'} → ${dto.applies_to ?? '—'}`);
    }
    if (dto.description !== undefined && dto.description !== rule.description) {
      changes.push(`Description: ${rule.description ?? '—'} → ${dto.description ?? '—'}`);
    }
    if (dto.value_json !== undefined) {
      changes.push(`Value: ${JSON.stringify(rule.value_json)} → ${JSON.stringify(dto.value_json)}`);
    }

    void this.auditLogs.log({
      entity_type: 'HR_POLICY_RULE',
      entity_id: String(ruleId),
      action: 'UPDATED',
      changed_by: changedBy,
      note: changes.length > 0 ? changes.join('; ') : 'No field changes detected.',
    });
    return updated;
  }

  async removeRule(setId: number, ruleId: number, changedBy: string, user?: IJwtStaffPayload) {
    await this.findOneSet(setId, user);
    const rule = await this.prisma.hr_policy_rules.findUnique({
      where: { id: ruleId }
    });
    if (!rule || rule.policy_set_id !== setId) {
      throw new NotFoundException(`Rule with ID ${ruleId} not found in policy set ${setId}`);
    }
    const deleted = await this.prisma.hr_policy_rules.delete({
      where: { id: ruleId }
    });
    void this.auditLogs.log({
      entity_type: 'HR_POLICY_RULE',
      entity_id: String(ruleId),
      action: 'DELETED',
      changed_by: changedBy,
      note: `Deleted rule "${rule.rule_type}" from policy set #${setId}.`,
    });
    return deleted;
  }
}
