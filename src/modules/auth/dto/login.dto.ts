import { IsString, IsNotEmpty, MinLength, IsEmail, IsOptional, Length } from 'class-validator';

export class LoginDto {
  @IsString()
  @IsNotEmpty()
  username: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  password: string;

  @IsOptional()
  @IsString()
  fcmToken?: string;

  @IsOptional()
  @IsString()
  deviceType?: string;
}

export class RefreshTokenDto {
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

export class VerifyCnicDto {
  @IsString()
  @IsNotEmpty()
  cnic: string;
}

export class RegisterParentDto {
  @IsString()
  @IsNotEmpty()
  cnic: string;

  @IsEmail()
  email: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  password: string;

  @IsString()
  @Length(4, 4)
  otp: string;

  @IsOptional()
  @IsString()
  fcmToken?: string;

  @IsOptional()
  @IsString()
  deviceType?: string;
}
