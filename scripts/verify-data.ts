import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
    const ids = [1, 2, 3, 6495, 7569, 7888];
    for (const id of ids) {
        const student = await prisma.students.findUnique({ where: { cc: id } });
        if (student) {
            console.log(`CC ${id} (${student.full_name}): DOB=${student.dob}, DOA=${student.doa}, Gender=${student.gender}`);
        } else {
            console.log(`CC ${id}: NOT FOUND`);
        }
    }
}
main().finally(() => prisma.$disconnect());
