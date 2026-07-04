import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface TemplateEntry {
  key: string;
  value: string;
  description: string;
}

const templates: TemplateEntry[] = [
  // Fee — Issued
  { key: 'notif_fee_issued_title', value: 'School Fees: {month}', description: 'Fee issued push title. Vars: {month}' },
  { key: 'notif_fee_issued_body', value: "Please pay {student_name}'s {month} school fees by {due_date}.", description: 'Fee issued push body. Vars: {student_name}, {month}, {due_date}' },

  // Fee — Due reminders (3d, 2d, 1d)
  { key: 'notif_fee_due_3d_title', value: 'Fee Reminder: {month}', description: 'Fee due 3-day reminder title. Vars: {month}' },
  { key: 'notif_fee_due_3d_body', value: "{student_name}'s {month} school fees are due on {due_date}. Please pay on time to avoid late charges.", description: 'Fee due 3-day reminder body. Vars: {student_name}, {month}, {due_date}' },
  { key: 'notif_fee_due_2d_title', value: 'Fee Reminder: {month}', description: 'Fee due 2-day reminder title. Vars: {month}' },
  { key: 'notif_fee_due_2d_body', value: "{student_name}'s {month} school fees are due on {due_date}. Please pay on time to avoid late charges.", description: 'Fee due 2-day reminder body. Vars: {student_name}, {month}, {due_date}' },
  { key: 'notif_fee_due_1d_title', value: 'Fee Reminder: {month}', description: 'Fee due 1-day reminder title. Vars: {month}' },
  { key: 'notif_fee_due_1d_body', value: "{student_name}'s {month} school fees are due on {due_date}. Please pay on time to avoid late charges.", description: 'Fee due 1-day reminder body. Vars: {student_name}, {month}, {due_date}' },

  // Fee — Overdue
  { key: 'notif_fee_overdue_title', value: 'Fee Overdue: {month}', description: 'Fee overdue push title. Vars: {month}' },
  { key: 'notif_fee_overdue_body', value: "{student_name}'s {month} school fees were due on {due_date} and are now overdue. Please pay as soon as possible.", description: 'Fee overdue push body. Vars: {student_name}, {month}, {due_date}' },

  // Fee — Expiry reminders (3d, 2d, 1d)
  { key: 'notif_fee_expiry_3d_title', value: 'Payment Deadline Approaching', description: 'Fee expiry 3-day reminder title.' },
  { key: 'notif_fee_expiry_3d_body', value: "{student_name}'s outstanding school fees must be paid by {expiry_date}. Please settle the balance soon.", description: 'Fee expiry 3-day reminder body. Vars: {student_name}, {expiry_date}' },
  { key: 'notif_fee_expiry_2d_title', value: 'Payment Deadline Approaching', description: 'Fee expiry 2-day reminder title.' },
  { key: 'notif_fee_expiry_2d_body', value: "{student_name}'s outstanding school fees must be paid by {expiry_date}. Please settle the balance soon.", description: 'Fee expiry 2-day reminder body. Vars: {student_name}, {expiry_date}' },
  { key: 'notif_fee_expiry_1d_title', value: 'Payment Deadline Approaching', description: 'Fee expiry 1-day reminder title.' },
  { key: 'notif_fee_expiry_1d_body', value: "{student_name}'s outstanding school fees must be paid by {expiry_date}. Please settle the balance soon.", description: 'Fee expiry 1-day reminder body. Vars: {student_name}, {expiry_date}' },

  // Attendance
  { key: 'notif_attend_arrived_title', value: 'Arrived at School', description: 'Student arrived push title.' },
  { key: 'notif_attend_arrived_body', value: '{student_name} has arrived at TAFS at {time}', description: 'Student arrived push body. Vars: {student_name}, {time}' },
  { key: 'notif_attend_late_title', value: 'Arrived Late', description: 'Student arrived late push title.' },
  { key: 'notif_attend_late_body', value: '{student_name} has arrived late at TAFS at {time}', description: 'Student arrived late push body. Vars: {student_name}, {time}' },
  { key: 'notif_attend_left_title', value: 'Left School', description: 'Student left school push title.' },
  { key: 'notif_attend_left_body', value: '{student_name} has left TAFS at {time}', description: 'Student left school push body. Vars: {student_name}, {time}' },

  // Calendar
  { key: 'notif_holiday_title', value: 'School Closed', description: 'Holiday push title.' },
  { key: 'notif_holiday_body', value: '{student_name} — TAFS is closed on {date} for {description}.', description: 'Holiday push body. Vars: {student_name}, {date}, {description}' },
  { key: 'notif_school_open_title', value: 'School Open', description: 'School open push title.' },
  { key: 'notif_school_open_body', value: '{student_name} — TAFS will be open on {date}.', description: 'School open push body. Vars: {student_name}, {date}' },
  { key: 'notif_day_off_title', value: 'Scheduled Day Off', description: 'Day off push title.' },
  { key: 'notif_day_off_body', value: '{student_name} — TAFS is closed on {date} (weekend).', description: 'Day off push body. Vars: {student_name}, {date}' },

  // Staff — Saturday schedule
  { key: 'notif_staff_saturday_title', value: 'Working Saturday Notice', description: 'Staff Saturday schedule push title. Vars: {month}' },
  { key: 'notif_staff_saturday_body', value: 'You are required to attend school on the following Saturday(s) in {month}: {date_list}. {attendance_note}', description: 'Staff Saturday schedule push body. Vars: {month}, {date_list}, {attendance_note}' },
];

async function main() {
  console.log(`Seeding ${templates.length} notification templates into app_config...`);

  for (const t of templates) {
    await prisma.app_config.upsert({
      where: { key: t.key },
      update: {},
      create: {
        key: t.key,
        value: t.value,
        description: t.description,
        updated_by: 'SEED',
        updated_at: new Date(),
      },
    });
    console.log(`  ✓ ${t.key}`);
  }

  console.log('Notification template seeding complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
