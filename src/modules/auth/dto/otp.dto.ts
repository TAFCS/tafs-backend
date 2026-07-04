import { IsString, IsNotEmpty, IsEmail, MinLength, Length } from 'class-validator';

export class SendSignupOtpDto {
  @IsString()
  @IsNotEmpty()
  cnic: string;

  @IsEmail()
  email: string;
}

export class ForgotPasswordDto {
  @IsEmail()
  email: string;
}

export class ResetPasswordDto {
  @IsEmail()
  email: string;

  @IsString()
  @Length(4, 4)
  code: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  newPassword: string;
}
