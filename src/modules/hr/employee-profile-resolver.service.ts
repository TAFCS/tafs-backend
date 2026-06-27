import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class EmployeeProfileResolverService {
  constructor(private readonly prisma: PrismaService) {}

  async requireByUserId(userId: string) {
    const profile = await this.prisma.employee_profiles.findUnique({
      where: { user_id: userId },
      select: {
        id: true,
        full_name: true,
        employee_code: true,
        campus_id: true,
        leaving_time: true,
        reporting_time: true,
      },
    });
    if (!profile) {
      throw new ForbiddenException('No employee profile is linked to this account');
    }
    return profile;
  }
}
