import { IsString, IsNotEmpty } from 'class-validator';

export class MeezanBillInquiryDto {
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
}
