import { Injectable, UnauthorizedException, Inject, forwardRef, ConflictException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { UsersService } from '../users/users.service';
import { PermissionsService } from '../users/permissions.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { OtpService } from '../otp/otp.service';
import {
  IJwtStaffPayload,
  IJwtParentPayload,
} from './interfaces/jwt-payload.interface';
import { LoginDto, RefreshTokenDto, VerifyCnicDto, RegisterParentDto } from './dto/login.dto';
import { SendSignupOtpDto, ForgotPasswordDto, ResetPasswordDto } from './dto/otp.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { otp_purpose } from '@prisma/client';
import { FcmService } from '../../common/fcm/fcm.service';

export const ACCESS_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
export const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

const ACCESS_TOKEN_TTL = '90d';
const REFRESH_TOKEN_TTL = '90d';

@Injectable()
export class AuthService {
  constructor(
    @Inject(forwardRef(() => UsersService))
    private usersService: UsersService,
    @Inject(forwardRef(() => PermissionsService))
    private permissionsService: PermissionsService,
    private jwtService: JwtService,
    private configService: ConfigService,
    private prisma: PrismaService,
    private otpService: OtpService,
    private fcmService: FcmService,
  ) {}

  // ─── Staff ─────────────────────────────────────────────────────────────────

  async loginStaff(dto: LoginDto) {
    const user = await this.usersService.findStaffByUsername(dto.username);

    if (!user || !user.is_active) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isMatch = await bcrypt.compare(dto.password, user.password_hash);
    if (!isMatch) throw new UnauthorizedException('Invalid credentials');

    const permissions = await this.permissionsService.getEffectivePermissions(user.id, user.role);

    const allowedClassIds = user.allowed_class_ids ?? [];

    const employeeProfile = await this.prisma.employee_profiles.findUnique({
      where: { user_id: user.id },
      select: { id: true },
    });

    const payload: IJwtStaffPayload = {
      sub: user.id,
      username: user.username,
      role: user.role,
      campusId: user.campus_id,
      allowedClassIds,
      userType: 'STAFF',
      permissions,
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
        campusName: user.campuses?.campus_name ?? null,
        allowedClassIds,
        permissions,
        hasEmployeeProfile: !!employeeProfile,
      },
    };
  }

  /**
   * Refreshes a staff session.
   * `rawToken` comes from the `tafs_refresh` httpOnly cookie (never the request body).
   */
  async refreshStaffToken(rawToken: string | undefined) {
    if (!rawToken) {
      throw new UnauthorizedException('No refresh token provided');
    }

    const existing = await this.findValidStaffRefreshToken(rawToken);
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
      include: { campuses: true },
    });
    if (!user || !user.is_active) {
      throw new UnauthorizedException('Account is inactive');
    }

    const permissions = await this.permissionsService.getEffectivePermissions(user.id, user.role);

    const allowedClassIds = user.allowed_class_ids ?? [];

    const employeeProfile = await this.prisma.employee_profiles.findUnique({
      where: { user_id: user.id },
      select: { id: true },
    });

    const payload: IJwtStaffPayload = {
      sub: user.id,
      username: user.username,
      role: user.role,
      campusId: user.campus_id,
      allowedClassIds,
      userType: 'STAFF',
      permissions,
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
        campusName: user.campuses?.campus_name ?? null,
        allowedClassIds,
        permissions,
        hasEmployeeProfile: !!employeeProfile,
      },
    };
  }

  async logoutStaff(userId: string, fcmToken?: string) {
    await this.prisma.user_refresh_tokens.updateMany({
      where: { user_id: userId, revoked_at: null },
      data: { revoked_at: new Date() },
    });

    if (fcmToken) {
      await this.fcmService
        .unregisterToken(fcmToken, { userId })
        .catch((e) =>
          console.error('Failed to unregister staff FCM token on logout:', e.message),
        );
    }
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
      familyId: family.id,
      userType: 'PARENT',
    };

    const { accessToken, refreshToken } =
      await this.generateTokenPair(payload);
    await this.storeParentRefreshToken(family.id, refreshToken);

    // If FCM token provided on login, save it immediately
    if (dto.fcmToken) {
      await this.prisma.fcm_device_tokens.upsert({
        where: { device_token: dto.fcmToken },
        update: {
          family_id: family.id,
          device_os: dto.deviceType,
          last_active_at: new Date(),
        },
        create: {
          family_id: family.id,
          device_token: dto.fcmToken,
          device_os: dto.deviceType,
        },
      }).catch(e => console.error('Failed to save FCM token on login:', e.message));
    }

    return {
      accessToken,
      refreshToken,
      ...(await this._fetchParentData(family.id)),
    };
  }

  async getParentProfile(familyId: number) {
    return this._fetchParentData(familyId);
  }

  private async _fetchParentData(familyId: number) {
    const family = await this.prisma.families.findUnique({
      where: { id: familyId },
    });
    if (!family) throw new UnauthorizedException('Account not found');

    const students = await this.prisma.students.findMany({
      where: { family_id: familyId },
      select: {
        cc: true,
        full_name: true,
        gr_number: true,
        photograph_url: true,
        academic_year: true,
        campus_id: true,
        class_id: true,
        section_id: true,
        campuses: { select: { campus_name: true, campus_code: true } },
        classes: { select: { description: true, class_code: true } },
        sections: { select: { description: true } },
      },
    });

    const familyGuardians = await this.prisma.student_guardians.findMany({
      where: {
        students: { family_id: familyId },
      },
      include: { guardians: true },
    });

    // Unique by guardian ID
    const uniqueGuardians = Array.from(
      new Map(familyGuardians.map((g) => [g.guardian_id, g])).values(),
    );

    const primaryGuardian = uniqueGuardians.find((g: any) => g.is_primary_contact);

    return {
      family: {
        id: family.id,
        email: family.email ?? '',
        householdName: family.household_name,
        homePhone: family.home_phone || null,
        photographUrl: primaryGuardian?.guardians?.photo_url ?? null,
        guardians: uniqueGuardians.map((g: any) => {
          const guardian = g.guardians;
          const phoneCode = guardian.primary_phone_country_code ?? '';
          const phoneNum = guardian.primary_phone ?? '';
          const fullPhone = phoneNum.startsWith(phoneCode)
            ? phoneNum
            : `${phoneCode}${phoneNum}`;

          return {
            id: guardian.id,
            name: guardian.full_name,
            relationship: g.relationship,
            phone: fullPhone || null,
            photographUrl: guardian.photo_url,
            email: guardian.email_address || null,
            occupation: guardian.occupation || null,
            organization: guardian.organization || null,
            education: guardian.education_level || null,
            cnic: guardian.cnic || null,
            whatsapp: guardian.whatsapp_number || null,
            address: guardian.mailing_address || null,
            houseApptName: guardian.house_appt_name || null,
            areaBlock: guardian.area_block || null,
            city: guardian.city || null,
            province: guardian.province || null,
            country: guardian.country || null,
            postalCode: guardian.postal_code || null,
            jobPosition: guardian.job_position || null,
            isEmergencyContact: g.is_emergency_contact ?? false,
          };
        }),
      },
      students: students.map((student) => ({
        cc: student.cc,
        fullName: student.full_name,
        grNumber: student.gr_number,
        photographUrl: student.photograph_url,
        campus: student.campuses?.campus_name ?? null,
        campusCode: student.campuses?.campus_code ?? null,
        className: student.classes?.description ?? null,
        classCode: student.classes?.class_code ?? null,
        section: student.sections?.description ?? null,
        academicYear: student.academic_year,
        campusId: student.campus_id,
        classId: student.class_id,
        sectionId: student.section_id,
      })),
    };
  }

  async refreshParentToken(dto: RefreshTokenDto) {
    if (!dto.refreshToken?.trim()) {
      throw new UnauthorizedException('No refresh token provided');
    }

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
      select: {
        id: true,
        deleted_at: true,
      },
    });
    if (!family || family.deleted_at) throw new UnauthorizedException('Account not found');

    const payload: IJwtParentPayload = {
      sub: family.id,
      familyId: family.id,
      userType: 'PARENT',
    };

    const { accessToken, refreshToken } =
      await this.generateTokenPair(payload);
    await this.storeParentRefreshToken(family.id, refreshToken);

    return { accessToken, refreshToken };
  }

  async logoutParent(familyId: number, fcmToken?: string) {
    await this.prisma.family_refresh_tokens.updateMany({
      where: { family_id: familyId, revoked_at: null },
      data: { revoked_at: new Date() },
    });

    if (fcmToken) {
      await this.fcmService
        .unregisterToken(fcmToken, { familyId })
        .catch((e) =>
          console.error('Failed to unregister parent FCM token on logout:', e.message),
        );
    }
  }

  /**
   * Permanently deletes the *app account* for a parent.
   *
   * Notes:
   * - We cannot hard-delete `families` because it is linked to school records.
   * - We "delete" the account by revoking sessions and removing login capability
   *   (nulling credentials) while keeping required institutional records intact.
   */
  async deleteParentAccount(familyId: number) {
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      // Revoke all refresh tokens immediately
      await tx.family_refresh_tokens.updateMany({
        where: { family_id: familyId, revoked_at: null },
        data: { revoked_at: now },
      });

      // Remove push notification tokens
      await tx.fcm_device_tokens.deleteMany({
        where: { family_id: familyId },
      });

      // Detach chat conversation from the family account (if present)
      await tx.chat_conversations.updateMany({
        where: { family_id: familyId },
        data: {
          family_id: null,
          unread_by_parent: 0,
          last_message_snippet: null,
        },
      });

      // Disable further logins + mark deleted. Keep household name (non-sensitive),
      // but remove email/password so the account cannot be accessed again.
      await tx.families.update({
        where: { id: familyId },
        data: {
          deleted_at: now,
          password_hash: null,
          email: null,
        },
      });
    });
  }

  // ─── Signup/Registration ───────────────────────────────────────────────────

  /**
   * Verify if a guardian with the given CNIC exists in the system
   */
  async verifyCnic(dto: VerifyCnicDto) {
    const guardian = await this.prisma.guardians.findUnique({
      where: { cnic: dto.cnic },
      select: { id: true, full_name: true },
    });

    if (!guardian) {
      return {
        exists: false,
        message: 'CNIC not found in system',
      };
    }

    return {
      exists: true,
      message: 'CNIC verified successfully',
      guardianId: guardian.id,
      guardianName: guardian.full_name,
    };
  }

  /**
   * Register a parent account using a verified CNIC.
   * Attaches login credentials to the guardian's existing institutional family.
   */
  async registerParent(dto: RegisterParentDto) {
    const normalizedEmail = dto.email.toLowerCase().trim();

    // Verify OTP before any DB mutations
    const otpResult = await this.otpService.verify({
      purpose: otp_purpose.PARENT_SIGNUP,
      email: normalizedEmail,
      code: dto.otp,
    });

    const guardian = await this.prisma.guardians.findUnique({
      where: { cnic: dto.cnic },
      select: { id: true, full_name: true },
    });

    if (!guardian) {
      throw new BadRequestException('CNIC not found in system');
    }

    const resolvedFamilyId = await this._resolveFamilyIdByGuardianId(guardian.id);
    if (!resolvedFamilyId) {
      throw new BadRequestException(
        'No students linked to this CNIC. Please contact the school office.',
      );
    }

    // Defensive check: OTP's familyId must match freshly-resolved one
    if (otpResult.familyId && otpResult.familyId !== resolvedFamilyId) {
      throw new BadRequestException(
        'Verification mismatch. Please restart the signup process.',
      );
    }

    const institutionalFamily = await this.prisma.families.findUnique({
      where: { id: resolvedFamilyId },
    });

    if (!institutionalFamily) {
      throw new BadRequestException(
        'No students linked to this CNIC. Please contact the school office.',
      );
    }

    // Only block re-registration if the account is ACTIVE (not deleted) and already has credentials.
    // A soft-deleted account (deleted_at set) must always be allowed to re-register.
    if (!institutionalFamily.deleted_at && (institutionalFamily.email || institutionalFamily.password_hash)) {
      throw new ConflictException(
        'Account already registered. Please log in.',
      );
    }

    const emailTakenElsewhere = await this.prisma.families.findFirst({
      where: {
        email: normalizedEmail,
        id: { not: resolvedFamilyId },
      },
    });

    if (emailTakenElsewhere) {
      throw new ConflictException('Email already in use');
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);

    const family = await this.prisma.families.update({
      where: { id: resolvedFamilyId },
      data: {
        email: normalizedEmail,
        password_hash: passwordHash,
        household_name: guardian.full_name || institutionalFamily.household_name,
        deleted_at: null, // Clear soft-delete flag in case the account was previously deleted and is being re-registered
      },
    });

    // Generate tokens
    const payload: IJwtParentPayload = {
      sub: family.id,
      familyId: family.id,
      userType: 'PARENT',
    };

    const { accessToken, refreshToken } =
      await this.generateTokenPair(payload);
    await this.storeParentRefreshToken(family.id, refreshToken);

    // If FCM token provided on registration, save it immediately
    if (dto.fcmToken) {
      await this.prisma.fcm_device_tokens.upsert({
        where: { device_token: dto.fcmToken },
        update: {
          family_id: family.id,
          device_os: dto.deviceType,
          last_active_at: new Date(),
        },
        create: {
          family_id: family.id,
          device_token: dto.fcmToken,
          device_os: dto.deviceType,
        },
      }).catch(e => console.error('Failed to save FCM token on registration:', e.message));
    }

    return {
      accessToken,
      refreshToken,
      ...(await this._fetchParentData(family.id)),
    };
  }

  // ─── Signup OTP ────────────────────────────────────────────────────────────

  async sendSignupOtp(dto: SendSignupOtpDto) {
    const guardian = await this.prisma.guardians.findUnique({
      where: { cnic: dto.cnic },
      select: { id: true },
    });

    if (!guardian) {
      throw new BadRequestException('CNIC not found in system');
    }

    const resolvedFamilyId = await this._resolveFamilyIdByGuardianId(guardian.id);
    if (!resolvedFamilyId) {
      throw new BadRequestException(
        'No students linked to this CNIC. Please contact the school office.',
      );
    }

    const institutionalFamily = await this.prisma.families.findUnique({
      where: { id: resolvedFamilyId },
    });

    if (!institutionalFamily) {
      throw new BadRequestException(
        'No students linked to this CNIC. Please contact the school office.',
      );
    }

    // Only block re-registration if the account is ACTIVE (not deleted) and already has credentials.
    // A soft-deleted account (deleted_at set) must always be allowed to re-register.
    if (!institutionalFamily.deleted_at && (institutionalFamily.email || institutionalFamily.password_hash)) {
      throw new ConflictException(
        'Account already registered. Please log in.',
      );
    }

    const normalizedEmail = dto.email.toLowerCase().trim();
    const emailTakenElsewhere = await this.prisma.families.findFirst({
      where: {
        email: normalizedEmail,
        id: { not: resolvedFamilyId },
      },
    });

    if (emailTakenElsewhere) {
      throw new ConflictException('Email already in use');
    }

    await this.otpService.issue({
      purpose: otp_purpose.PARENT_SIGNUP,
      email: normalizedEmail,
      familyId: resolvedFamilyId,
      cnic: dto.cnic,
    });
  }

  // ─── Forgot / Reset Password ─────────────────────────────────────────────

  async forgotPasswordParent(dto: ForgotPasswordDto) {
    const normalizedEmail = dto.email.toLowerCase().trim();

    const family = await this.prisma.families.findFirst({
      where: {
        email: normalizedEmail,
        deleted_at: null,
        password_hash: { not: null },
      },
      orderBy: { created_at: 'desc' },
    });

    if (family) {
      await this.otpService.issue({
        purpose: otp_purpose.PARENT_FORGOT_PASSWORD,
        email: normalizedEmail,
        familyId: family.id,
      });
    }
    // Always return success to prevent email enumeration
  }

  async forgotPasswordStaff(dto: ForgotPasswordDto) {
    const normalizedEmail = dto.email.toLowerCase().trim();

    const user = await this.prisma.users.findUnique({
      where: { email: normalizedEmail },
    });

    if (user && user.is_active && !user.deleted_at) {
      await this.otpService.issue({
        purpose: otp_purpose.STAFF_FORGOT_PASSWORD,
        email: normalizedEmail,
        userId: user.id,
      });
    }
    // Always return success to prevent email enumeration
  }

  async resetPasswordParent(dto: ResetPasswordDto) {
    const otpResult = await this.otpService.verify({
      purpose: otp_purpose.PARENT_FORGOT_PASSWORD,
      email: dto.email,
      code: dto.code,
    });

    if (!otpResult.familyId) {
      throw new BadRequestException('Invalid or expired code');
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, 10);

    await this.prisma.families.update({
      where: { id: otpResult.familyId },
      data: { password_hash: passwordHash },
    });

    // Revoke all existing refresh tokens, forcing re-login on all devices
    await this.logoutParent(otpResult.familyId);
    await this.prisma.fcm_device_tokens.deleteMany({
      where: { family_id: otpResult.familyId },
    });
  }

  async resetPasswordStaff(dto: ResetPasswordDto) {
    const otpResult = await this.otpService.verify({
      purpose: otp_purpose.STAFF_FORGOT_PASSWORD,
      email: dto.email,
      code: dto.code,
    });

    if (!otpResult.userId) {
      throw new BadRequestException('Invalid or expired code');
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, 10);

    await this.prisma.users.update({
      where: { id: otpResult.userId },
      data: { password_hash: passwordHash },
    });

    // Revoke all existing refresh tokens, forcing re-login on all devices
    await this.logoutStaff(otpResult.userId);
    await this.prisma.fcm_device_tokens.deleteMany({
      where: { user_id: otpResult.userId },
    });
  }

  async changePasswordParent(familyId: number, dto: ChangePasswordDto) {
    const family = await this.prisma.families.findUnique({
      where: { id: familyId },
      select: { password_hash: true },
    });

    if (!family?.password_hash) {
      throw new UnauthorizedException('Account not found');
    }

    const isMatch = await bcrypt.compare(dto.currentPassword, family.password_hash);
    if (!isMatch) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException('New password must be different from current password');
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, 10);
    await this.prisma.families.update({
      where: { id: familyId },
      data: { password_hash: passwordHash },
    });
  }

  async changePasswordStaff(userId: string, dto: ChangePasswordDto) {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { password_hash: true, is_active: true },
    });

    if (!user?.password_hash || !user.is_active) {
      throw new UnauthorizedException('Account not found');
    }

    const isMatch = await bcrypt.compare(dto.currentPassword, user.password_hash);
    if (!isMatch) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException('New password must be different from current password');
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, 10);
    await this.prisma.users.update({
      where: { id: userId },
      data: { password_hash: passwordHash },
    });
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /**
   * Resolve the institutional family for a guardian via student_guardians → students.family_id.
   */
  private async _resolveFamilyIdByGuardianId(
    guardianId: number,
  ): Promise<number | null> {
    const links = await this.prisma.student_guardians.findMany({
      where: { guardian_id: guardianId },
      include: {
        students: {
          select: { family_id: true, deleted_at: true },
        },
      },
    });

    const familyIds = new Set<number>();
    for (const link of links) {
      const student = link.students;
      if (student && !student.deleted_at && student.family_id) {
        familyIds.add(student.family_id);
      }
    }

    if (familyIds.size === 0) {
      return null;
    }

    if (familyIds.size > 1) {
      throw new BadRequestException(
        'Multiple households found for this CNIC. Please contact the school office.',
      );
    }

    return [...familyIds][0];
  }

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
    // Revoke all existing tokens before inserting so the table stays lean
    // and validation only ever needs one bcrypt.compare.
    await this.prisma.user_refresh_tokens.updateMany({
      where: { user_id: userId, revoked_at: null },
      data: { revoked_at: new Date() },
    });
    await this.prisma.user_refresh_tokens.create({
      data: { user_id: userId, token_hash: tokenHash, expires_at: expiresAt },
    });
  }

  private async storeParentRefreshToken(familyId: number, rawToken: string) {
    const tokenHash = await bcrypt.hash(rawToken, 10);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
    // Same cleanup as staff tokens.
    await this.prisma.family_refresh_tokens.updateMany({
      where: { family_id: familyId, revoked_at: null },
      data: { revoked_at: new Date() },
    });
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
    if (decoded.userType !== 'STAFF') {
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
    if (decoded.userType !== 'PARENT') {
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
