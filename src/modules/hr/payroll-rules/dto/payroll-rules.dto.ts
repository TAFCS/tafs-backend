import { IsBoolean, IsIn, IsObject, IsOptional, IsString } from 'class-validator';

export const PAYROLL_STATUTORY_RULE_TYPES = ['EOBI', 'SESSI', 'INCOME_TAX'] as const;
export type PayrollStatutoryRuleType = (typeof PAYROLL_STATUTORY_RULE_TYPES)[number];

export class CreatePayrollStatutoryRuleDto {
  @IsIn(PAYROLL_STATUTORY_RULE_TYPES)
  rule_type: PayrollStatutoryRuleType;

  @IsString()
  effective_from: string;

  @IsObject()
  value_json: any;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
