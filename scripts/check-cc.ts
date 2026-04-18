import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
    const ids = [1, 2, 6495, 7888];
    for (const id of ids) {
        const student = await prisma.students.findUnique({ where: { cc: id } });
        console.log(`CC ${id}: ${student ? 'FOUND (' + student.full_name + ')' : 'NOT FOUND'}`);
    }
}
main().finally(() => prisma.$disconnect());
