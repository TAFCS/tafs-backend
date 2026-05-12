import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class MeezanBillPaymentDto {
  @IsString()
  @IsNotEmpty()
  ServiceUserId: string;

  @IsString()
  @IsNotEmpty()
  UserPassword: string;

  @IsOptional()
  @IsString()
  BillCompanyCode?: string;

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

  @IsString()
  @IsNotEmpty()
  BankCode: string;

  @IsString()
  @IsNotEmpty()
  BankName: string;

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
  DateOfReturn?: string; // yyyymmdd

  @IsOptional()
  @IsString()
  ReasonDescription?: string;
}
