
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const cc = 1;
  const targetDate = new Date('2025-09-01');

  console.log(`Checking data for Student CC: ${cc} as of ${targetDate.toISOString()}`);

  const student = await prisma.students.findUnique({
    where: { cc },
    include: {
      campuses: true,
      classes: true,
      sections: true,
    }
  });

  if (!student) {
    console.log("Student not found");
    return;
  }

  console.log("Student:", student.full_name, "Campus:", student.campuses?.campus_name);

  const fees = await prisma.student_fees.findMany({
    where: {
      student_id: cc,
    },
    include: {
      fee_types: true
    },
    orderBy: { fee_date: 'desc' }
  });

  console.log("\n--- All Fees found ---");
  fees.forEach(f => {
    console.log(`Date: ${f.fee_date?.toISOString().split('T')[0]}, Type: ${f.fee_types.description}, Amount: ${f.amount}, Paid: ${f.amount_paid}, Status: ${f.status}`);
  });

  // Calculate Arrears (unpaid fees before target month)
  const arrears = fees.filter(f => f.fee_date && f.fee_date < targetDate && Number(f.amount_paid || 0) < Number(f.amount || 0));
  
  console.log("\n--- Arrears (Unpaid before Sept 2025) ---");
  if (arrears.length === 0) {
    console.log("No arrears found.");
  } else {
    arrears.forEach(f => {
      const outstanding = Number(f.amount || 0) - Number(f.amount_paid || 0);
      console.log(`Month: ${f.fee_date?.toISOString().split('T')[0]}, Head: ${f.fee_types.description}, Outstanding: ${outstanding}`);
    });
  }

  // September 2025 fees
  const septFees = fees.filter(f => f.fee_date?.toISOString().startsWith('2025-09'));
  console.log("\n--- September 2025 Fees ---");
  septFees.forEach(f => {
    console.log(`Type: ${f.fee_types.description}, Amount: ${f.amount}`);
  });
}

main()
  .catch(e => console.error(e))
  .finally(async () => {
    await prisma.$disconnect();
  });
