import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class MeezanBillPaymentDto {
  @IsString()
  @IsNotEmpty()
  ServiceUserId: string;

  @IsString()
  @IsNotEmpty()
  UserPassword: string;

  @IsString()
  @IsNotEmpty()
  BillCompanyCode: string;

  @IsString()
  @IsNotEmpty()
  VoucherNumber: string;

  @IsString()
  @IsNotEmpty()
  TransDate: string; // yyyymmdd

  @IsString()
  @IsNotEmpty()
  TransAuthenticationCode: string;

  @IsString()
  @IsNotEmpty()
  TransAmount: string;

  @IsString()
  @IsNotEmpty()
  PaymentMode: string; // CASH or CHQ

  @IsOptional()
  @IsString()
  ChequeNo?: string;

  @IsString()
  @IsNotEmpty()
  Status: string; // C = Cleared, L = Lodged, R = Return

  @IsOptional()
  @IsString()
  ReasonCode?: string;

  @IsOptional()
  @IsString()
  ReasonDescription?: string;
}
