import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { UsersModule } from '../users/users.module';
import { JwtStaffStrategy } from './strategies/jwt-staff.strategy';
import { JwtParentStrategy } from './strategies/jwt-parent.strategy';
import { CaslAbilityFactory } from './casl/casl-ability.factory';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { PrismaService } from '../../../prisma/prisma.service';
import { ParentChangeRequestsModule } from '../parent-change-requests/parent-change-requests.module';
import { FcmModule } from '../../common/fcm/fcm.module';
import { OtpModule } from '../otp/otp.module';

@Module({
  imports: [
    forwardRef(() => UsersModule),
    forwardRef(() => ParentChangeRequestsModule),
    FcmModule,
    OtpModule,
    PassportModule,
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: '15m' },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStaffStrategy,
    JwtParentStrategy,
    CaslAbilityFactory,
    PoliciesGuard,
    PrismaService,
  ],
  exports: [AuthService, CaslAbilityFactory, PoliciesGuard, JwtModule],
})
export class AuthModule {}
