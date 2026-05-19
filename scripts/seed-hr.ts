import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding HR & Attendance Foundation...');

  // 1. Seed Leave Types
  const leaveTypes = [
    { name: 'Sick Leave', description: 'Paid sick leave', is_paid: true },
    { name: 'Casual Leave', description: 'Paid casual leave', is_paid: true },
    { name: 'Annual Leave', description: 'Paid annual leave', is_paid: true },
    { name: 'Unpaid Leave', description: 'Unpaid leave of absence', is_paid: false },
  ];

  for (const lt of leaveTypes) {
    const existing = await prisma.leave_types.findFirst({
      where: { name: lt.name },
    });
    if (existing) {
      await prisma.leave_types.update({
        where: { id: existing.id },
        data: lt,
      });
    } else {
      await prisma.leave_types.create({
        data: lt,
      });
    }
  }
  console.log('Leave types seeded.');

  // 2. Seed Class Attendance Modes
  const classes = await prisma.classes.findMany();
  for (const c of classes) {
    const mode = (c.id === 21 || c.id === 22) ? 'ROLL_CALL_SESSION' : 'BIOMETRIC_DAILY';
    await prisma.class_attendance_modes.upsert({
      where: { class_id: c.id },
      update: { mode },
      create: { class_id: c.id, mode },
    });
  }
  console.log(`Class attendance modes seeded for ${classes.length} classes.`);

  // 3. Seed Campus Policy Sets & Default Rules
  const campuses = await prisma.campuses.findMany();
  const today = new Date();

  for (const campus of campuses) {
    // Find or create policy set
    let policySet = await prisma.hr_policy_sets.findFirst({
      where: { campus_id: campus.id, academic_year: '2025-2026' }
    });

    if (!policySet) {
      policySet = await prisma.hr_policy_sets.create({
        data: {
          campus_id: campus.id,
          academic_year: '2025-2026',
          effective_from: today,
          description: `Default Policy Set for ${campus.campus_name}`,
        }
      });
    }

    // Default Rules
    const defaultRules = [
      {
        policy_set_id: policySet.id,
        rule_type: 'MIN_ATTENDANCE_PCT',
        value_json: { percentage: 80 },
        description: 'Minimum required attendance percentage',
      },
      {
        policy_set_id: policySet.id,
        rule_type: 'LATE_GRACE_PERIOD_MINS',
        value_json: { minutes: 15 },
        description: 'Late arrival grace period in minutes',
      },
      {
        policy_set_id: policySet.id,
        rule_type: 'HALF_DAY_LATE_COUNT',
        value_json: { count: 3 },
        description: 'Number of late arrivals that trigger a half-day deduction',
      },
      {
        policy_set_id: policySet.id,
        rule_type: 'ABSENT_FINE_AMOUNT',
        value_json: { amount: 500 },
        description: 'Fine amount for unexcused absence',
      }
    ];

    for (const rule of defaultRules) {
      await prisma.hr_policy_rules.upsert({
        where: {
          policy_set_id_rule_type: {
            policy_set_id: rule.policy_set_id,
            rule_type: rule.rule_type
          }
        },
        update: {
          value_json: rule.value_json,
          description: rule.description
        },
        create: rule
      });
    }
  }

  console.log(`HR policy sets and rules seeded for ${campuses.length} campuses.`);
  console.log('HR Seeding complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
