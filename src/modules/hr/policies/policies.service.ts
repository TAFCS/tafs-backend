import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';

export class CreatePolicySetDto {
  campus_id: number;
  academic_year: string;
  effective_from: string;
  description?: string;
}

export class CreatePolicyRuleDto {
  rule_type: string;
  value_json: any;
  applies_to?: string;
  description?: string;
}

@Injectable()
export class PoliciesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAllSets(campusId: number) {
    return this.prisma.hr_policy_sets.findMany({
      where: { campus_id: campusId },
      include: { hr_policy_rules: true }
    });
  }

  async findOneSet(id: number) {
    const set = await this.prisma.hr_policy_sets.findUnique({
      where: { id },
      include: { hr_policy_rules: true }
    });
    if (!set) {
      throw new NotFoundException(`Policy set with ID ${id} not found`);
    }
    return set;
  }

  async createSet(dto: CreatePolicySetDto) {
    return this.prisma.hr_policy_sets.create({
      data: {
        campus_id: dto.campus_id,
        academic_year: dto.academic_year,
        effective_from: new Date(dto.effective_from),
        description: dto.description || null
      }
    });
  }

  async updateSet(id: number, dto: Partial<CreatePolicySetDto>) {
    await this.findOneSet(id);
    return this.prisma.hr_policy_sets.update({
      where: { id },
      data: {
        campus_id: dto.campus_id,
        academic_year: dto.academic_year,
        effective_from: dto.effective_from ? new Date(dto.effective_from) : undefined,
        description: dto.description
      }
    });
  }

  async removeSet(id: number) {
    await this.findOneSet(id);
    return this.prisma.hr_policy_sets.delete({
      where: { id }
    });
  }

  // Rules CRUD
  async createRule(setId: number, dto: CreatePolicyRuleDto) {
    await this.findOneSet(setId);
    return this.prisma.hr_policy_rules.create({
      data: {
        policy_set_id: setId,
        rule_type: dto.rule_type,
        value_json: dto.value_json,
        applies_to: dto.applies_to || null,
        description: dto.description || null
      }
    });
  }

  async updateRule(setId: number, ruleId: number, dto: Partial<CreatePolicyRuleDto>) {
    const rule = await this.prisma.hr_policy_rules.findUnique({
      where: { id: ruleId }
    });
    if (!rule || rule.policy_set_id !== setId) {
      throw new NotFoundException(`Rule with ID ${ruleId} not found in policy set ${setId}`);
    }
    return this.prisma.hr_policy_rules.update({
      where: { id: ruleId },
      data: {
        rule_type: dto.rule_type,
        value_json: dto.value_json,
        applies_to: dto.applies_to,
        description: dto.description
      }
    });
  }

  async removeRule(setId: number, ruleId: number) {
    const rule = await this.prisma.hr_policy_rules.findUnique({
      where: { id: ruleId }
    });
    if (!rule || rule.policy_set_id !== setId) {
      throw new NotFoundException(`Rule with ID ${ruleId} not found in policy set ${setId}`);
    }
    return this.prisma.hr_policy_rules.delete({
      where: { id: ruleId }
    });
  }
}
