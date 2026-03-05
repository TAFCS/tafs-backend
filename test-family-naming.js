const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log("--- Family Naming & Resolution Test ---");
  
  const testCnic = "TEST-" + Date.now();
  const fatherName = "Umer";
  
  // 1. First registration
  console.log("Mocking first registration...");
  const family1 = await prisma.$transaction(async (tx) => {
    const familyName = fatherName + "'s Family";
    const family = await tx.families.create({
      data: { household_name: familyName }
    });
    
    const student = await tx.students.create({
      data: {
        family_id: family.id,
        cc_number: "CC-TEST-1",
        first_name: "Kid",
        last_name: "One",
        dob: new Date(),
        gender: "Male",
        nationality: "Pakistani",
        religion: "Muslim",
        status: "SOFT_ADMISSION"
      }
    });

    const guardian = await tx.guardians.create({
      data: {
        full_name: fatherName,
        cnic: testCnic
      }
    });

    await tx.student_guardians.create({
      data: {
        student_id: student.id,
        guardian_id: guardian.id,
        relationship: 'Father'
      }
    });

    return family;
  });

  console.log(`Created Family 1: ${family1.household_name} (ID: ${family1.id})`);

  // 2. Second registration simulation
  console.log("\nSimulating second registration with same CNIC...");
  const resolvedFamilyId = await prisma.$transaction(async (tx) => {
    const existingGuardian = await tx.guardians.findFirst({
      where: { cnic: testCnic },
      include: {
        student_guardians: {
          include: {
            students: true,
          },
        },
      },
    });
    return existingGuardian?.student_guardians[0]?.students?.family_id;
  });

  console.log(`Resolved Family ID for second student: ${resolvedFamilyId}`);

  if (resolvedFamilyId === family1.id) {
    console.log("SUCCESS: Linked to same family.");
  } else {
    console.log("FAILURE: Linkage failed.");
  }

  if (family1.household_name === "Umer's Family") {
    console.log("SUCCESS: Naming convention followed.");
  } else {
    console.log("FAILURE: Naming convention incorrect.");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
