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
import { createApiResponse } from '../../utils/serializer.util';
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
  async loginStaff(@Body() dto: LoginDto) {
    const result = await this.authService.loginStaff(dto);
    return createApiResponse(result, HttpStatus.OK, 'Staff login successful');
  }

  @Post('staff/refresh')
  @HttpCode(HttpStatus.OK)
  async refreshStaff(@Body() dto: RefreshTokenDto) {
    const result = await this.authService.refreshStaffToken(dto);
    return createApiResponse(result, HttpStatus.OK, 'Staff token refreshed');
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
  async loginParent(@Body() dto: LoginDto) {
    const result = await this.authService.loginParent(dto);
    return createApiResponse(result, HttpStatus.OK, 'Parent login successful');
  }

  @Post('parent/refresh')
  @HttpCode(HttpStatus.OK)
  async refreshParent(@Body() dto: RefreshTokenDto) {
    const result = await this.authService.refreshParentToken(dto);
    return createApiResponse(result, HttpStatus.OK, 'Parent token refreshed');
  }

  @Post('parent/logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtParentGuard)
  logoutParent(@CurrentUser() user: IJwtParentPayload) {
    return this.authService.logoutParent(user.familyId);
  }
}
