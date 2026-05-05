import { IsString, IsNotEmpty, MinLength, IsEmail } from 'class-validator';

export class LoginDto {
  @IsString()
  @IsNotEmpty()
  username: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  password: string;
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
}
