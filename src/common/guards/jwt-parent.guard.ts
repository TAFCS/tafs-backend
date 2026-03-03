import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtParentGuard extends AuthGuard('jwt-parent') {}
