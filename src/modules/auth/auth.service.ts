import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { UsersService } from '../users/users.service';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  IJwtStaffPayload,
  IJwtParentPayload,
} from './interfaces/jwt-payload.interface';
import { LoginDto, RefreshTokenDto } from './dto/login.dto';

const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL = '7d';
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {}

  // ─── Staff ─────────────────────────────────────────────────────────────────

  async loginStaff(dto: LoginDto) {
    const user = await this.usersService.findStaffByUsername(dto.username);

    if (!user || !user.is_active) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isMatch = await bcrypt.compare(dto.password, user.password_hash);
    if (!isMatch) throw new UnauthorizedException('Invalid credentials');

    const payload: IJwtStaffPayload = {
      sub: user.id,
      username: user.username,
      role: user.role,
      campusId: user.campus_id,
      userType: 'STAFF',
    };

    const { accessToken, refreshToken } =
      await this.generateTokenPair(payload);
    await this.storeStaffRefreshToken(user.id, refreshToken);

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        username: user.username,
        fullName: user.full_name,
        role: user.role,
        campusId: user.campus_id,
        campusName: user.campus?.campus_name ?? null,
      },
    };
  }

  async refreshStaffToken(dto: RefreshTokenDto) {
    const existing = await this.findValidStaffRefreshToken(dto.refreshToken);
    if (!existing) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    // Revoke the consumed token (rotation)
    await this.prisma.user_refresh_tokens.update({
      where: { id: existing.id },
      data: { revoked_at: new Date() },
    });

    const user = await this.prisma.users.findUnique({
      where: { id: existing.user_id },
    });
    if (!user || !user.is_active) {
      throw new UnauthorizedException('Account is inactive');
    }

    const payload: IJwtStaffPayload = {
      sub: user.id,
      username: user.username,
      role: user.role,
      campusId: user.campus_id,
      userType: 'STAFF',
    };

    const { accessToken, refreshToken } =
      await this.generateTokenPair(payload);
    await this.storeStaffRefreshToken(user.id, refreshToken);

    return { accessToken, refreshToken };
  }

  async logoutStaff(userId: string) {
    await this.prisma.user_refresh_tokens.updateMany({
      where: { user_id: userId, revoked_at: null },
      data: { revoked_at: new Date() },
    });
  }

  // ─── Parent ────────────────────────────────────────────────────────────────

  async loginParent(dto: LoginDto) {
    const family = await this.usersService.findParentByUsername(dto.username);

    if (!family || !family.password_hash) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isMatch = await bcrypt.compare(dto.password, family.password_hash);
    if (!isMatch) throw new UnauthorizedException('Invalid credentials');

    const payload: IJwtParentPayload = {
      sub: family.id,
      username: family.username as string,
      familyId: family.id,
      userType: 'PARENT',
    };

    const { accessToken, refreshToken } =
      await this.generateTokenPair(payload);
    await this.storeParentRefreshToken(family.id, refreshToken);

    return {
      accessToken,
      refreshToken,
      family: {
        id: family.id,
        username: family.username,
        householdName: family.household_name,
      },
    };
  }

  async refreshParentToken(dto: RefreshTokenDto) {
    const existing = await this.findValidParentRefreshToken(dto.refreshToken);
    if (!existing) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    await this.prisma.family_refresh_tokens.update({
      where: { id: existing.id },
      data: { revoked_at: new Date() },
    });

    const family = await this.prisma.families.findUnique({
      where: { id: existing.family_id },
    });
    if (!family) throw new UnauthorizedException('Account not found');

    const payload: IJwtParentPayload = {
      sub: family.id,
      username: family.username as string,
      familyId: family.id,
      userType: 'PARENT',
    };

    const { accessToken, refreshToken } =
      await this.generateTokenPair(payload);
    await this.storeParentRefreshToken(family.id, refreshToken);

    return { accessToken, refreshToken };
  }

  async logoutParent(familyId: number) {
    await this.prisma.family_refresh_tokens.updateMany({
      where: { family_id: familyId, revoked_at: null },
      data: { revoked_at: new Date() },
    });
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private async generateTokenPair(
    payload: IJwtStaffPayload | IJwtParentPayload,
  ) {
    const accessToken = this.jwtService.sign(payload, {
      secret: this.configService.get<string>('JWT_SECRET'),
      expiresIn: ACCESS_TOKEN_TTL,
    });

    // Refresh token carries minimal data — just sub + userType
    const refreshToken = this.jwtService.sign(
      { sub: payload.sub, userType: payload.userType },
      {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
        expiresIn: REFRESH_TOKEN_TTL,
      },
    );

    return { accessToken, refreshToken };
  }

  private async storeStaffRefreshToken(userId: string, rawToken: string) {
    const tokenHash = await bcrypt.hash(rawToken, 10);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
    await this.prisma.user_refresh_tokens.create({
      data: { user_id: userId, token_hash: tokenHash, expires_at: expiresAt },
    });
  }

  private async storeParentRefreshToken(familyId: number, rawToken: string) {
    const tokenHash = await bcrypt.hash(rawToken, 10);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
    await this.prisma.family_refresh_tokens.create({
      data: {
        family_id: familyId,
        token_hash: tokenHash,
        expires_at: expiresAt,
      },
    });
  }

  private async findValidStaffRefreshToken(rawToken: string) {
    // 1. Verify signature + expiry to safely extract the subject
    let decoded: { sub: string; userType: string };
    try {
      decoded = this.jwtService.verify<{ sub: string; userType: string }>(
        rawToken,
        { secret: this.configService.get<string>('JWT_REFRESH_SECRET') },
      );
    } catch {
      return null;
    }

    // 2. Narrow DB lookup to this user's active, non-expired tokens
    const tokens = await this.prisma.user_refresh_tokens.findMany({
      where: {
        user_id: decoded.sub,
        revoked_at: null,
        expires_at: { gt: new Date() },
      },
    });

    // 3. Bcrypt compare to find the matching token record
    for (const token of tokens) {
      const isMatch = await bcrypt.compare(rawToken, token.token_hash);
      if (isMatch) return token;
    }
    return null;
  }

  private async findValidParentRefreshToken(rawToken: string) {
    let decoded: { sub: number; userType: string };
    try {
      decoded = this.jwtService.verify<{ sub: number; userType: string }>(
        rawToken,
        { secret: this.configService.get<string>('JWT_REFRESH_SECRET') },
      );
    } catch {
      return null;
    }

    const tokens = await this.prisma.family_refresh_tokens.findMany({
      where: {
        family_id: Number(decoded.sub),
        revoked_at: null,
        expires_at: { gt: new Date() },
      },
    });

    for (const token of tokens) {
      const isMatch = await bcrypt.compare(rawToken, token.token_hash);
      if (isMatch) return token;
    }
    return null;
  }
}
