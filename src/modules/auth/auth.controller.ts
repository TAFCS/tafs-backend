import {
  Controller,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService, ACCESS_TOKEN_TTL_MS, REFRESH_TOKEN_TTL_MS } from './auth.service';
import { LoginDto, RefreshTokenDto, VerifyCnicDto, RegisterParentDto } from './dto/login.dto';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { JwtParentGuard } from '../../common/guards/jwt-parent.guard';
import { CurrentUser } from '../../decorators/current-user.decorator';
import { createApiResponse } from '../../utils/serializer.util';
import type {
  IJwtStaffPayload,
  IJwtParentPayload,
} from './interfaces/jwt-payload.interface';

// ─── Cookie helpers ────────────────────────────────────────────────────────────

const IS_PROD = process.env.NODE_ENV === 'production';
const ACCESS_COOKIE_TTL = ACCESS_TOKEN_TTL_MS;
const REFRESH_COOKIE_TTL = REFRESH_TOKEN_TTL_MS;

function setAuthCookies(res: Response, accessToken: string, refreshToken: string) {
  const base = {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: IS_PROD ? ('none' as const) : ('lax' as const),
  };
  res.cookie('tafs_access', accessToken, { ...base, maxAge: ACCESS_COOKIE_TTL });
  res.cookie('tafs_refresh', refreshToken, { ...base, maxAge: REFRESH_COOKIE_TTL });
  // tafs_session is a presence-flag cookie read by Next.js middleware for
  // server-side route protection. Also httpOnly so JS cannot forge it.
  res.cookie('tafs_session', '1', { ...base, maxAge: REFRESH_COOKIE_TTL });
}

function clearAuthCookies(res: Response) {
  const base = {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: IS_PROD ? ('none' as const) : ('lax' as const),
  };
  res.clearCookie('tafs_access', base);
  res.clearCookie('tafs_refresh', base);
  res.clearCookie('tafs_session', base);
}

// ─── Controller ───────────────────────────────────────────────────────────────

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) { }

  // ─── Staff (cookie-based — webapp only) ────────────────────────────────────

  @Post('staff/login')
  @HttpCode(HttpStatus.OK)
  async loginStaff(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { accessToken, refreshToken, user } =
      await this.authService.loginStaff(dto);
    setAuthCookies(res, accessToken, refreshToken);
    // Tokens go in httpOnly cookies — only the user object is returned in the body
    return createApiResponse({ user }, HttpStatus.OK, 'Staff login successful');
  }

  @Post('staff/refresh')
  @HttpCode(HttpStatus.OK)
  async refreshStaff(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Refresh token is read from the httpOnly cookie — never from the request body
    const rawRefreshToken = req.cookies?.tafs_refresh as string | undefined;
    const { accessToken, refreshToken, user } =
      await this.authService.refreshStaffToken(rawRefreshToken);
    setAuthCookies(res, accessToken, refreshToken);
    return createApiResponse({ user }, HttpStatus.OK, 'Staff token refreshed');
  }

  @Post('staff/logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtStaffGuard)
  async logoutStaff(
    @CurrentUser() user: IJwtStaffPayload,
    @Res({ passthrough: true }) res: Response,
  ) {
    clearAuthCookies(res);
    return this.authService.logoutStaff(user.sub);
  }

  // ─── Parent (body-based — Flutter mobile app) ──────────────────────────────
  // Flutter uses FlutterSecureStorage (OS keychain), not browser cookies.
  // Tokens are kept in the request/response body for mobile compatibility.

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

  // ─── Parent Signup (Flutter mobile app) ───────────────────────────────────

  @Post('parent/verify-cnic')
  @HttpCode(HttpStatus.OK)
  async verifyCnic(@Body() dto: VerifyCnicDto) {
    const result = await this.authService.verifyCnic(dto);
    return createApiResponse(result, HttpStatus.OK, 'CNIC verification result');
  }

  @Post('parent/register')
  @HttpCode(HttpStatus.CREATED)
  async registerParent(@Body() dto: RegisterParentDto) {
    const result = await this.authService.registerParent(dto);
    return createApiResponse(result, HttpStatus.CREATED, 'Registration successful');
  }
}
