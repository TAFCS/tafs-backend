import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import {
  IJwtStaffPayload,
  IJwtParentPayload,
} from '../modules/auth/interfaces/jwt-payload.interface';

export const CurrentUser = createParamDecorator(
  (
    data: unknown,
    ctx: ExecutionContext,
  ): IJwtStaffPayload | IJwtParentPayload => {
    const request = ctx.switchToHttp().getRequest();
    return request.user as IJwtStaffPayload | IJwtParentPayload;
  },
);
