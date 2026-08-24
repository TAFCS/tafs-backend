import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const EFFECTIVE_FROM = new Date('2026-07-01');

const initialRules = [
  {
    rule_type: 'EOBI',
    effective_from: EFFECTIVE_FROM,
    description: 'FY 2026-27 EOBI contribution (federal, minimum-wage based)',
    value_json: {
      employer_percent: 5,
      employee_percent: 1,
      wage_base_amount: 43000,
    },
  },
  {
    rule_type: 'SESSI',
    effective_from: EFFECTIVE_FROM,
    description: 'FY 2026-27 SESSI contribution (Sindh, employer-only, minimum-wage based)',
    value_json: {
      employer_percent: 7,
      wage_base_amount: 43000,
    },
  },
  {
    rule_type: 'INCOME_TAX',
    effective_from: EFFECTIVE_FROM,
    description: 'FY 2026-27 FBR income tax slabs for salaried individuals',
    value_json: {
      exemption_threshold: 600000,
      slabs: [
        { min: 0, max: 600000, fixed_amount: 0, rate_percent: 0 },
        { min: 600001, max: 1200000, fixed_amount: 0, rate_percent: 1 },
        { min: 1200001, max: 2200000, fixed_amount: 6000, rate_percent: 11 },
        { min: 2200001, max: 3200000, fixed_amount: 116000, rate_percent: 20 },
        { min: 3200001, max: 4100000, fixed_amount: 316000, rate_percent: 25 },
        { min: 4100001, max: 5600000, fixed_amount: 541000, rate_percent: 29 },
        { min: 5600001, max: 7000000, fixed_amount: 976000, rate_percent: 32 },
        { min: 7000001, max: null, fixed_amount: 1424000, rate_percent: 35 },
      ],
    },
  },
];

async function main() {
  console.log('Seeding payroll_statutory_rules...');

  for (const rule of initialRules) {
    await prisma.payroll_statutory_rules.upsert({
      where: {
        rule_type_effective_from: {
          rule_type: rule.rule_type,
          effective_from: rule.effective_from,
        },
      },
      update: {},
      create: rule,
    });
  }

  console.log('payroll_statutory_rules seeding complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
