import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtStaffGuard extends AuthGuard('jwt-staff') {}
