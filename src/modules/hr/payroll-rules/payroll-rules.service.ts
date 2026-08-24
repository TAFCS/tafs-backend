import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { CreatePayrollStatutoryRuleDto, PAYROLL_STATUTORY_RULE_TYPES } from './dto/payroll-rules.dto';

@Injectable()
export class PayrollRulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async findAll(ruleType?: string) {
    return this.prisma.payroll_statutory_rules.findMany({
      where: ruleType ? { rule_type: ruleType } : undefined,
      orderBy: [{ rule_type: 'asc' }, { effective_from: 'desc' }],
    });
  }

  async findOne(id: number) {
    const rule = await this.prisma.payroll_statutory_rules.findUnique({ where: { id } });
    if (!rule) {
      throw new NotFoundException(`Payroll statutory rule with ID ${id} not found`);
    }
    return rule;
  }

  /** Most recent version of `ruleType` that was already in effect on `asOfDate`, or null if none. */
  async findEffective(ruleType: string, asOfDate: Date) {
    return this.prisma.payroll_statutory_rules.findFirst({
      where: { rule_type: ruleType, effective_from: { lte: asOfDate } },
      orderBy: { effective_from: 'desc' },
    });
  }

  async create(dto: CreatePayrollStatutoryRuleDto, changedBy: string) {
    this.validateValueJson(dto.rule_type, dto.value_json);
    const created = await this.prisma.payroll_statutory_rules
      .create({
        data: {
          rule_type: dto.rule_type,
          effective_from: new Date(dto.effective_from),
          value_json: dto.value_json,
          description: dto.description || null,
          is_active: dto.is_active ?? true,
        },
      })
      .catch((e) => this.handleUniqueConflict(e, dto.rule_type, dto.effective_from));

    void this.auditLogs.log({
      entity_type: 'PAYROLL_STATUTORY_RULE',
      entity_id: String(created.id),
      action: 'CREATED',
      changed_by: changedBy,
      note: `Created ${created.rule_type} rule effective ${created.effective_from.toISOString().slice(0, 10)}.${created.description ? ` ${created.description}` : ''}`,
    });
    return created;
  }

  async update(id: number, dto: Partial<CreatePayrollStatutoryRuleDto>, changedBy: string) {
    const existing = await this.findOne(id);
    const ruleType = dto.rule_type ?? existing.rule_type;
    if (dto.value_json !== undefined) {
      this.validateValueJson(ruleType, dto.value_json);
    }

    const updated = await this.prisma.payroll_statutory_rules
      .update({
        where: { id },
        data: {
          rule_type: dto.rule_type,
          effective_from: dto.effective_from ? new Date(dto.effective_from) : undefined,
          value_json: dto.value_json,
          description: dto.description,
          is_active: dto.is_active,
        },
      })
      .catch((e) =>
        this.handleUniqueConflict(e, ruleType, dto.effective_from ?? existing.effective_from.toISOString()),
      );

    const changes: string[] = [];
    if (dto.effective_from !== undefined) {
      const newDate = new Date(dto.effective_from).toISOString().slice(0, 10);
      const oldDate = existing.effective_from.toISOString().slice(0, 10);
      if (newDate !== oldDate) changes.push(`Effective From: ${oldDate} → ${newDate}`);
    }
    if (dto.value_json !== undefined) {
      changes.push(`Value: ${JSON.stringify(existing.value_json)} → ${JSON.stringify(dto.value_json)}`);
    }
    if (dto.is_active !== undefined && dto.is_active !== existing.is_active) {
      changes.push(`Active: ${existing.is_active} → ${dto.is_active}`);
    }
    if (dto.description !== undefined && dto.description !== existing.description) {
      changes.push(`Description: ${existing.description ?? '—'} → ${dto.description ?? '—'}`);
    }

    void this.auditLogs.log({
      entity_type: 'PAYROLL_STATUTORY_RULE',
      entity_id: String(id),
      action: 'UPDATED',
      changed_by: changedBy,
      note: changes.length > 0 ? changes.join('; ') : 'No field changes detected.',
    });
    return updated;
  }

  async remove(id: number, changedBy: string) {
    const existing = await this.findOne(id);
    const deleted = await this.prisma.payroll_statutory_rules.delete({ where: { id } });
    void this.auditLogs.log({
      entity_type: 'PAYROLL_STATUTORY_RULE',
      entity_id: String(id),
      action: 'DELETED',
      changed_by: changedBy,
      note: `Deleted ${existing.rule_type} rule effective ${existing.effective_from.toISOString().slice(0, 10)}.`,
    });
    return deleted;
  }

  private handleUniqueConflict(e: unknown, ruleType: string, effectiveFrom: string): never {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new BadRequestException(
        `A ${ruleType} rule effective ${new Date(effectiveFrom).toISOString().slice(0, 10)} already exists.`,
      );
    }
    throw e;
  }

  private validateValueJson(ruleType: string, valueJson: unknown) {
    if (!PAYROLL_STATUTORY_RULE_TYPES.includes(ruleType as (typeof PAYROLL_STATUTORY_RULE_TYPES)[number])) {
      throw new BadRequestException(
        `Unknown rule_type "${ruleType}". Expected one of: ${PAYROLL_STATUTORY_RULE_TYPES.join(', ')}.`,
      );
    }
    if (typeof valueJson !== 'object' || valueJson === null || Array.isArray(valueJson)) {
      throw new BadRequestException('value_json must be an object.');
    }
    const value = valueJson as Record<string, unknown>;

    if (ruleType === 'EOBI' || ruleType === 'SESSI') {
      if (typeof value.employer_percent !== 'number' || value.employer_percent < 0) {
        throw new BadRequestException(`${ruleType} rule requires a non-negative numeric employer_percent.`);
      }
      if (typeof value.wage_base_amount !== 'number' || value.wage_base_amount < 0) {
        throw new BadRequestException(`${ruleType} rule requires a non-negative numeric wage_base_amount.`);
      }
      if (ruleType === 'EOBI' && (typeof value.employee_percent !== 'number' || value.employee_percent < 0)) {
        throw new BadRequestException('EOBI rule requires a non-negative numeric employee_percent.');
      }
    }

    if (ruleType === 'INCOME_TAX') {
      if (typeof value.exemption_threshold !== 'number' || value.exemption_threshold < 0) {
        throw new BadRequestException('INCOME_TAX rule requires a non-negative numeric exemption_threshold.');
      }
      if (!Array.isArray(value.slabs) || value.slabs.length === 0) {
        throw new BadRequestException('INCOME_TAX rule requires a non-empty slabs array.');
      }
      let previousMax: number | null = null;
      for (const [index, slab] of (value.slabs as unknown[]).entries()) {
        if (typeof slab !== 'object' || slab === null) {
          throw new BadRequestException(`Slab at index ${index} must be an object.`);
        }
        const { min, max, fixed_amount, rate_percent } = slab as Record<string, unknown>;
        if (typeof min !== 'number' || typeof fixed_amount !== 'number' || typeof rate_percent !== 'number') {
          throw new BadRequestException(
            `Slab at index ${index} must have numeric min, fixed_amount, and rate_percent.`,
          );
        }
        if (max !== null && typeof max !== 'number') {
          throw new BadRequestException(`Slab at index ${index}'s max must be a number or null (top slab).`);
        }
        if (max !== null && max <= min) {
          throw new BadRequestException(`Slab at index ${index} must have max greater than min.`);
        }
        if (previousMax !== null && min !== previousMax + 1) {
          throw new BadRequestException(
            `Slab at index ${index} must start immediately after the previous slab's max (expected min ${previousMax + 1}).`,
          );
        }
        previousMax = max;
      }
      if (previousMax !== null) {
        throw new BadRequestException('The last (highest) slab must have max: null.');
      }
    }
  }
}
