import {
  Controller,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto, RefreshTokenDto } from './dto/login.dto';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { JwtParentGuard } from '../../common/guards/jwt-parent.guard';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type {
  IJwtStaffPayload,
  IJwtParentPayload,
} from './interfaces/jwt-payload.interface';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // ─── Staff ─────────────────────────────────────────────────────────────────

  @Post('staff/login')
  @HttpCode(HttpStatus.OK)
  loginStaff(@Body() dto: LoginDto) {
    return this.authService.loginStaff(dto);
  }

  @Post('staff/refresh')
  @HttpCode(HttpStatus.OK)
  refreshStaff(@Body() dto: RefreshTokenDto) {
    return this.authService.refreshStaffToken(dto);
  }

  @Post('staff/logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtStaffGuard)
  logoutStaff(@CurrentUser() user: IJwtStaffPayload) {
    return this.authService.logoutStaff(user.sub);
  }

  // ─── Parent ────────────────────────────────────────────────────────────────

  @Post('parent/login')
  @HttpCode(HttpStatus.OK)
  loginParent(@Body() dto: LoginDto) {
    return this.authService.loginParent(dto);
  }

  @Post('parent/refresh')
  @HttpCode(HttpStatus.OK)
  refreshParent(@Body() dto: RefreshTokenDto) {
    return this.authService.refreshParentToken(dto);
  }

  @Post('parent/logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtParentGuard)
  logoutParent(@CurrentUser() user: IJwtParentPayload) {
    return this.authService.logoutParent(user.familyId);
  }
}
