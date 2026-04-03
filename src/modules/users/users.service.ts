import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async findStaffByUsername(username: string) {
    return this.prisma.users.findUnique({
      where: { username },
      include: { campus: true },
    });
  }

  async findParentByUsername(username: string) {
    // For parents we now treat "username" as the email used for login
    return this.prisma.families.findFirst({
      where: { email: username },
      select: {
        id: true,
        email: true,
        household_name: true,
        password_hash: true,
      },
    });
  }
}
