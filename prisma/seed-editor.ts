import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
    const passwordHash = await bcrypt.hash('password123', 10);

    const user = await prisma.users.upsert({
        where: { username: 'testeditor' },
        update: {
            password_hash: passwordHash,
            role: 'STAFF_EDITOR',
        },
        create: {
            username: 'testeditor',
            password_hash: passwordHash,
            full_name: 'Test Editor',
            role: 'STAFF_EDITOR',
            email: 'testeditor@example.com',
            is_active: true,
            campus_id: 1, // Defaulting to Campus 1 (Aisha Bawany) mostly
        },
    });

    console.log('Seeded test editor user:', user);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
