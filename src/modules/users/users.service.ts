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
    return this.prisma.families.findUnique({
      where: { username: username },
    });
  }
}
