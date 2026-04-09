import { PrismaClient, StaffRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
    const passwordHash = await bcrypt.hash('password123', 10);

    const user = await prisma.users.upsert({
        where: { username: 'testeditor' },
        update: {
            password_hash: passwordHash,
            role: StaffRole.STAFF_EDITOR,
        },
        create: {
            id: require('crypto').randomUUID(),
            username: 'testeditor',
            password_hash: passwordHash,
            full_name: 'Test Editor',
            role: StaffRole.STAFF_EDITOR,
            email: 'testeditor@example.com',
            is_active: true,
            campus_id: 1, // Defaulting to Campus 1 (Aisha Bawany) mostly
            updated_at: new Date(),
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
